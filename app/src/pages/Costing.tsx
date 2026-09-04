import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getMyProfile } from "../lib/install/api";
import { isOwner } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import {
  addChangeOrder,
  addJobCost,
  bidForMargin,
  getCompanyCosting,
  setBid,
  toCsv,
} from "../lib/costing";

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}

export function Costing() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole, grants } = useEffectiveRole();
  // Wave Z: an owner, or anyone the owner granted "Sees costs". The database
  // decides the same way (can_see_costs(auth.uid()) on every money policy);
  // this only stops the screen asking for rows it would be refused.
  const canSeeCosts = isOwner(effectiveRole) || grants.costs === true;
  const jobs = useQuery({
    queryKey: ["companyCosting"],
    queryFn: getCompanyCosting,
    enabled: canSeeCosts,
  });
  const [sel, setSel] = useState<string>("");
  const [costAmt, setCostAmt] = useState("");
  const [costCat, setCostCat] = useState("materials");
  const [bid, setBidVal] = useState("");
  const [target, setTarget] = useState("");
  const [coLabel, setCoLabel] = useState("");
  const [coAmt, setCoAmt] = useState("");
  // Bid calculator
  const [calcCost, setCalcCost] = useState("");
  const [calcMargin, setCalcMargin] = useState("20");

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["companyCosting"] });
  const addCost = useMutation({
    mutationFn: () => addJobCost(sel, costCat, Number(costAmt)),
    onSuccess: () => { setCostAmt(""); refresh(); },
  });
  const saveBid = useMutation({
    mutationFn: () => setBid(sel, Number(bid), target ? Number(target) : null),
    onSuccess: refresh,
  });
  const addCo = useMutation({
    mutationFn: (args: { label: string; amount: number }) =>
      addChangeOrder(sel, args.label, args.amount),
    onSuccess: () => { setCoLabel(""); setCoAmt(""); refresh(); },
  });

  if (me.data && !canSeeCosts) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Job costing</h1>
          <BackChip fallback="/" label="Home" />
        </header>
        <p className="muted">
          Revenue, costs and margin. Ask an owner to turn on “Sees costs” for you.
        </p>
      </div>
    );
  }

  const rows = jobs.data ?? [];
  const totalRev = rows.reduce((s, r) => s + r.revenue, 0);
  const totalCost = rows.reduce((s, r) => s + r.costs, 0);
  const totalMargin = totalRev - totalCost;
  const marginPct = totalRev > 0 ? Math.round((totalMargin / totalRev) * 100) : 0;

  const exportCsv = () => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "job-costing.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const selJob = rows.find((r) => r.projectId === sel);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Job costing</h1>
          <p className="muted" style={{ margin: 0 }}>
            Revenue, costs and margin — owners, and anyone given “Sees costs”.
          </p>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>

      <div className="stat-grid">
        <div className="stat-card accent">
          <span className="stat-num">{money(totalRev)}</span>
          <span>revenue (all jobs)</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{money(totalCost)}</span>
          <span>costs to date</span>
        </div>
        <div className="stat-card">
          <span className={`stat-num ${totalMargin >= 0 ? "ok" : "error"}`}>{money(totalMargin)}</span>
          <span>margin now</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{marginPct}%</span>
          <span>margin %</span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Labor cost is auto-derived from clocked time_shifts x role rate; manual
        cost entries are adjustments on top.
      </p>

      <div className="row-between">
        <h2>Jobs</h2>
        <button className="button-like" onClick={exportCsv}>⤓ Export CSV</button>
      </div>

      <div className="job-chip-row">
        {rows.map((r) => (
          <button
            key={r.projectId}
            type="button"
            className={sel === r.projectId ? "job-chip active" : "job-chip"}
            onClick={() => setSel(r.projectId)}
          >
            {r.jobCode}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table className="analytics-table">
          <thead>
            <tr>
              <th>Job</th>
              <th className="num">Revenue</th>
              <th className="num">Costs</th>
              <th className="num">Margin</th>
              <th className="num">%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.projectId}
                onClick={() => setSel(r.projectId)}
                style={{ cursor: "pointer" }}
              >
                <td>{r.jobCode}</td>
                <td className="num">{money(r.revenue)}</td>
                <td className="num">{money(r.costs)}</td>
                <td className={"num " + (r.margin >= 0 ? "ok" : "error")}>{money(r.margin)}</td>
                <td className={"num " + (r.targetMarginPct && r.marginPct < r.targetMarginPct ? "warn-text" : "")}>
                  {r.marginPct}%
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="muted">No jobs yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selJob && (
        <div className="cost-hero">
          <div className="cost-hero-top">
            <strong style={{ fontSize: 16 }}>{selJob.jobCode}</strong>
            <div style={{ textAlign: "right" }}>
              <div className="muted" style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>
                Margin now
              </div>
              <div
                className="cost-margin"
                style={{ color: selJob.margin >= 0 ? "var(--ok)" : "var(--danger)" }}
              >
                {money(selJob.margin)}
              </div>
            </div>
          </div>
          <div className="cost-kv">
            <span>Bid / est. revenue</span>
            <strong>{money(selJob.revenue)}</strong>
          </div>
          <div className="cost-kv">
            <span>Costs to date</span>
            <strong>{money(selJob.costs)}</strong>
          </div>
          <div className="cost-kv">
            <span>Labor</span>
            <strong>{selJob.laborHours}h · {money(selJob.laborCost)}</strong>
          </div>
          <div className="cost-kv">
            <span>Manual costs</span>
            <strong>{money(selJob.manualCosts)}</strong>
          </div>
        </div>
      )}

      <h2>Edit a job</h2>
      <select value={sel} onChange={(e) => setSel(e.target.value)}>
        <option value="">— pick a job —</option>
        {rows.map((r) => (
          <option key={r.projectId} value={r.projectId}>
            {r.jobCode} — {r.name}
          </option>
        ))}
      </select>
      {selJob && (
        <div className="detail-card">
          <label className="field-label">Bid / est. revenue</label>
          <input
            type="number"
            value={bid}
            onChange={(e) => setBidVal(e.target.value)}
            placeholder={String(selJob.bid || "")}
          />
          <label className="field-label">Target margin %</label>
          <input
            type="number"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={String(selJob.targetMarginPct ?? "")}
          />
          <button
            className="action-btn"
            disabled={saveBid.isPending || !bid}
            onClick={() => saveBid.mutate()}
          >
            Save bid
          </button>

          <label className="field-label">Add cost</label>
          <select value={costCat} onChange={(e) => setCostCat(e.target.value)}>
            {["labor", "materials", "equipment", "subs", "other"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <input
            type="number"
            value={costAmt}
            onChange={(e) => setCostAmt(e.target.value)}
            placeholder="Amount $"
          />
          <button
            className="action-btn"
            disabled={addCost.isPending || !costAmt}
            onClick={() => addCost.mutate()}
          >
            Add cost
          </button>

          <label className="field-label">Change order</label>
          <input
            value={coLabel}
            onChange={(e) => setCoLabel(e.target.value)}
            placeholder="Description"
          />
          <input
            type="number"
            value={coAmt}
            onChange={(e) => setCoAmt(e.target.value)}
            placeholder="Amount $"
          />
          <button
            className="action-btn"
            disabled={addCo.isPending || !coLabel.trim() || !coAmt}
            onClick={() => addCo.mutate({ label: coLabel.trim(), amount: Number(coAmt) })}
          >
            Add change order
          </button>
        </div>
      )}

      <h2>Bid calculator</h2>
      <div className="bid-calc">
        <label className="field-label">Total cost (labor + supplies + overhead)</label>
        <input
          type="number"
          value={calcCost}
          onChange={(e) => setCalcCost(e.target.value)}
          placeholder="e.g. 40000"
        />
        <label className="field-label">Target margin %</label>
        <input
          type="number"
          value={calcMargin}
          onChange={(e) => setCalcMargin(e.target.value)}
        />
        {calcCost && (
          <p className="next-code">
            {money(bidForMargin(Number(calcCost), Number(calcMargin) || 0))}
          </p>
        )}
        <p className="muted">
          Bid this to hit {calcMargin || 0}% margin on {money(Number(calcCost) || 0)} cost.
        </p>
      </div>
    </div>
  );
}
