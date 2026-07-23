import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { QueryError, SkeletonCard } from "../ui/States";
import { listAllFinancials, listAllServiceRecords } from "../../lib/vehicles/api";
import { summarizeFleetFinancials } from "../../lib/vehicles/fleetFinancials";

function money(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/**
 * Owner-only fleet money rollup. Mounted ONLY when the real role is owner and
 * not previewing (see Vehicles), mirroring the per-vehicle FinancialsSection.
 * The `vehicle_financials` table is also owner-only via RLS, so the totals stay
 * unreadable to non-owners even if this rendered.
 */
export function FleetFinancialsSection({ vehicleCount }: { vehicleCount: number }) {
  const financials = useQuery({ queryKey: ["fleetFinancials"], queryFn: listAllFinancials });
  const service = useQuery({ queryKey: ["fleetServiceRecords"], queryFn: listAllServiceRecords });

  const isLoading = financials.isLoading || service.isLoading;
  const error = financials.error ?? service.error;

  const summary = useMemo(
    () =>
      summarizeFleetFinancials({
        vehicleCount,
        financials: financials.data ?? [],
        serviceRecords: service.data ?? [],
      }),
    [vehicleCount, financials.data, service.data],
  );

  return (
    <section className="veh-section veh-financials">
      <div className="veh-section-head">
        <h2>Fleet money</h2>
        <span className="veh-owner-lock">
          <Lock size={12} aria-hidden /> Owner only
        </span>
      </div>

      {financials.isError || service.isError ? (
        <QueryError
          error={error}
          onRetry={() => {
            void financials.refetch();
            void service.refetch();
          }}
          label="Couldn't load fleet money"
        />
      ) : isLoading ? (
        <SkeletonCard height={160} />
      ) : (
        <>
          <dl className="veh-details-grid">
            <dt>Monthly payments</dt>
            <dd>{money(summary.totalMonthlyPayments)}</dd>
            <dt>Total owed</dt>
            <dd>{money(summary.totalOutstanding)}</dd>
            <dt>Maintenance spend</dt>
            <dd>{money(summary.totalServiceCost)}</dd>
            <dt>Cost / vehicle</dt>
            <dd>{money(summary.costPerVehicle)}</dd>
            <dt>Interest / yr</dt>
            <dd>{money(summary.annualInterestExposure)}</dd>
            <dt>Financed / cash</dt>
            <dd>
              {summary.financedCount} / {summary.paidCashCount}
            </dd>
          </dl>
          <p className="veh-notes">
            Cost / vehicle combines logged maintenance and monthly payments across{" "}
            {summary.vehicleCount} {summary.vehicleCount === 1 ? "vehicle" : "vehicles"}.
          </p>
        </>
      )}
    </section>
  );
}
