import type { VehicleFinancials, VehicleServiceRecord } from "./types";

// Owner-only fleet money rollup. Pure aggregation over the existing
// `vehicle_financials` rows + `vehicle_service_records` cost log so it can be
// unit-tested without a browser or Supabase. The UI half of the gate lives in
// `financials.ts` (`canSeeFinancials`); this module only does the math.

export interface FleetFinancialsInput {
  /** Total vehicles in the fleet (denominator for the per-vehicle average). */
  vehicleCount: number;
  financials: Pick<
    VehicleFinancials,
    "paid_cash" | "loan_balance" | "interest_rate" | "monthly_payment"
  >[];
  serviceRecords: Pick<VehicleServiceRecord, "cost">[];
}

export interface FleetFinancialsSummary {
  vehicleCount: number;
  /** Vehicles marked paid-in-cash (no loan). */
  paidCashCount: number;
  /** Vehicles carrying a loan (not paid cash). */
  financedCount: number;
  /** Sum of monthly loan payments across financed vehicles. */
  totalMonthlyPayments: number;
  /** Sum of outstanding loan balances (amount still owed) across the fleet. */
  totalOutstanding: number;
  /** Lifetime maintenance/service spend logged against the fleet. */
  totalServiceCost: number;
  /** Service spend + monthly payments — the combined recurring + logged cost. */
  totalCombinedCost: number;
  /** `totalCombinedCost` averaged over every vehicle in the fleet. */
  costPerVehicle: number;
  /** Estimated annual interest cost = Σ(balance × rate%) over financed loans. */
  annualInterestExposure: number;
}

function toNumber(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export function summarizeFleetFinancials({
  vehicleCount,
  financials,
  serviceRecords,
}: FleetFinancialsInput): FleetFinancialsSummary {
  let paidCashCount = 0;
  let financedCount = 0;
  let totalMonthlyPayments = 0;
  let totalOutstanding = 0;
  let annualInterestExposure = 0;

  for (const f of financials) {
    if (f.paid_cash) {
      paidCashCount += 1;
      continue;
    }
    financedCount += 1;
    totalMonthlyPayments += toNumber(f.monthly_payment);
    const balance = toNumber(f.loan_balance);
    totalOutstanding += balance;
    annualInterestExposure += balance * (toNumber(f.interest_rate) / 100);
  }

  const totalServiceCost = serviceRecords.reduce((sum, r) => sum + toNumber(r.cost), 0);
  const totalCombinedCost = totalServiceCost + totalMonthlyPayments;
  const costPerVehicle = vehicleCount > 0 ? totalCombinedCost / vehicleCount : 0;

  return {
    vehicleCount,
    paidCashCount,
    financedCount,
    totalMonthlyPayments,
    totalOutstanding,
    totalServiceCost,
    totalCombinedCost,
    costPerVehicle,
    annualInterestExposure,
  };
}
