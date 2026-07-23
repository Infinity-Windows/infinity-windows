import { describe, expect, it } from "vitest";
import { summarizeFleetFinancials } from "./fleetFinancials";

describe("summarizeFleetFinancials", () => {
  it("is all zeros for an empty fleet", () => {
    const s = summarizeFleetFinancials({ vehicleCount: 0, financials: [], serviceRecords: [] });
    expect(s).toEqual({
      vehicleCount: 0,
      paidCashCount: 0,
      financedCount: 0,
      totalMonthlyPayments: 0,
      totalOutstanding: 0,
      totalServiceCost: 0,
      totalCombinedCost: 0,
      costPerVehicle: 0,
      annualInterestExposure: 0,
    });
  });

  it("sums payments, balances and interest only over financed vehicles", () => {
    const s = summarizeFleetFinancials({
      vehicleCount: 3,
      financials: [
        { paid_cash: false, loan_balance: 20000, interest_rate: 6, monthly_payment: 400 },
        { paid_cash: false, loan_balance: 10000, interest_rate: 5, monthly_payment: 250 },
        { paid_cash: true, loan_balance: null, interest_rate: null, monthly_payment: null },
      ],
      serviceRecords: [{ cost: 300 }, { cost: 200 }, { cost: null }],
    });

    expect(s.financedCount).toBe(2);
    expect(s.paidCashCount).toBe(1);
    expect(s.totalMonthlyPayments).toBe(650);
    expect(s.totalOutstanding).toBe(30000);
    expect(s.totalServiceCost).toBe(500);
    // 500 service + 650 payments
    expect(s.totalCombinedCost).toBe(1150);
    // combined / 3 vehicles
    expect(s.costPerVehicle).toBeCloseTo(1150 / 3);
    // 20000*0.06 + 10000*0.05 = 1200 + 500
    expect(s.annualInterestExposure).toBe(1700);
  });

  it("treats null/undefined money fields as zero", () => {
    const s = summarizeFleetFinancials({
      vehicleCount: 1,
      financials: [
        { paid_cash: false, loan_balance: null, interest_rate: null, monthly_payment: null },
      ],
      serviceRecords: [],
    });
    expect(s.financedCount).toBe(1);
    expect(s.totalMonthlyPayments).toBe(0);
    expect(s.totalOutstanding).toBe(0);
    expect(s.annualInterestExposure).toBe(0);
    expect(s.costPerVehicle).toBe(0);
  });

  it("ignores paid-cash vehicles in balance and interest even if fields are set", () => {
    const s = summarizeFleetFinancials({
      vehicleCount: 2,
      financials: [
        { paid_cash: true, loan_balance: 9999, interest_rate: 10, monthly_payment: 999 },
        { paid_cash: false, loan_balance: 5000, interest_rate: 4, monthly_payment: 100 },
      ],
      serviceRecords: [{ cost: 1000 }],
    });
    expect(s.paidCashCount).toBe(1);
    expect(s.financedCount).toBe(1);
    expect(s.totalMonthlyPayments).toBe(100);
    expect(s.totalOutstanding).toBe(5000);
    expect(s.annualInterestExposure).toBe(200);
    expect(s.totalServiceCost).toBe(1000);
    expect(s.costPerVehicle).toBeCloseTo(1100 / 2);
  });

  it("guards against divide-by-zero when vehicleCount is 0 but costs exist", () => {
    const s = summarizeFleetFinancials({
      vehicleCount: 0,
      financials: [{ paid_cash: false, loan_balance: 100, interest_rate: 5, monthly_payment: 50 }],
      serviceRecords: [{ cost: 100 }],
    });
    expect(s.totalCombinedCost).toBe(150);
    expect(s.costPerVehicle).toBe(0);
  });
});
