import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { QueryError, SkeletonCard } from "../ui/States";
import { getFinancials, saveFinancials } from "../../lib/vehicles/api";
import { toastSuccess } from "../../lib/toast";
import type { VehicleFinancials } from "../../lib/vehicles/types";

function num(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Owner-only financials. This component is mounted ONLY when the real role is
 * owner and not previewing (see VehicleDetail); the SEPARATE `vehicle_financials`
 * table is also protected by a strict owner-only RLS policy, so even if this
 * rendered it could not read/write the data as a non-owner.
 */
export function FinancialsSection({ vehicleId }: { vehicleId: string }) {
  const qc = useQueryClient();
  const fin = useQuery({
    queryKey: ["vehicleFinancials", vehicleId],
    queryFn: () => getFinancials(vehicleId),
  });

  const [paidCash, setPaidCash] = useState(false);
  const [purchasePrice, setPurchasePrice] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [loanBalance, setLoanBalance] = useState("");
  const [interestRate, setInterestRate] = useState("");
  const [monthlyPayment, setMonthlyPayment] = useState("");
  const [lenderBank, setLenderBank] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    const f = fin.data;
    if (!f) return;
    setPaidCash(f.paid_cash);
    setPurchasePrice(f.purchase_price != null ? String(f.purchase_price) : "");
    setPurchaseDate(f.purchase_date ?? "");
    setLoanBalance(f.loan_balance != null ? String(f.loan_balance) : "");
    setInterestRate(f.interest_rate != null ? String(f.interest_rate) : "");
    setMonthlyPayment(f.monthly_payment != null ? String(f.monthly_payment) : "");
    setLenderBank(f.lender_bank ?? "");
    setNotes(f.notes ?? "");
  }, [fin.data]);

  const save = useMutation({
    mutationFn: () =>
      saveFinancials(vehicleId, {
        paid_cash: paidCash,
        purchase_price: num(purchasePrice),
        purchase_date: purchaseDate || null,
        loan_balance: paidCash ? null : num(loanBalance),
        interest_rate: paidCash ? null : num(interestRate),
        monthly_payment: paidCash ? null : num(monthlyPayment),
        lender_bank: paidCash ? null : lenderBank.trim() || null,
        notes: notes.trim() || null,
      } as Omit<VehicleFinancials, "vehicle_id" | "updated_at">),
    onSuccess: () => {
      toastSuccess("Financials saved");
      qc.invalidateQueries({ queryKey: ["vehicleFinancials", vehicleId] });
    },
  });

  return (
    <section className="veh-section veh-financials">
      <div className="veh-section-head">
        <h2>Financials</h2>
        <span className="veh-owner-lock">
          <Lock size={12} aria-hidden /> Owner only
        </span>
      </div>

      {fin.isError ? (
        <QueryError error={fin.error} onRetry={() => void fin.refetch()} label="Couldn't load financials" />
      ) : fin.isLoading ? (
        <SkeletonCard height={180} />
      ) : (
        <>
          <label className="veh-check">
            <input type="checkbox" checked={paidCash} onChange={(e) => setPaidCash(e.target.checked)} />
            <span>Paid cash (no loan)</span>
          </label>

          <div className="sched-row-2">
            <div>
              <label className="field-label">Purchase price</label>
              <input type="number" inputMode="decimal" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} />
            </div>
            <div>
              <label className="field-label">Purchase date</label>
              <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
            </div>
          </div>

          {!paidCash && (
            <>
              <div className="sched-row-2">
                <div>
                  <label className="field-label">Loan balance</label>
                  <input type="number" inputMode="decimal" value={loanBalance} onChange={(e) => setLoanBalance(e.target.value)} />
                </div>
                <div>
                  <label className="field-label">Interest rate (%)</label>
                  <input type="number" inputMode="decimal" value={interestRate} onChange={(e) => setInterestRate(e.target.value)} />
                </div>
              </div>
              <div className="sched-row-2">
                <div>
                  <label className="field-label">Monthly payment</label>
                  <input type="number" inputMode="decimal" value={monthlyPayment} onChange={(e) => setMonthlyPayment(e.target.value)} />
                </div>
                <div>
                  <label className="field-label">Lender / bank</label>
                  <input type="text" value={lenderBank} onChange={(e) => setLenderBank(e.target.value)} />
                </div>
              </div>
            </>
          )}

          <label className="field-label">Notes</label>
          <textarea className="sched-note-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />

          <div className="sched-sheet-actions">
            <button className="button-like active-pill" style={{ marginLeft: "auto" }} onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save financials"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
