import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { listProjects } from "../lib/api";
import {
  addOrder,
  addSupply,
  listOrders,
  listSupplies,
  setOrderStatus,
} from "../lib/ops";

const STATUSES = ["needed", "ordered", "picked", "used"];

export function Supplies() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const supplies = useQuery({ queryKey: ["supplies"], queryFn: listSupplies });
  // Deep-link from a job hub ("Supplies for this job") preselects that job.
  const [proj, setProj] = useState(searchParams.get("job") ?? "");
  const [supplyId, setSupplyId] = useState("");
  const [qty, setQty] = useState("1");
  const [newName, setNewName] = useState("");

  const orders = useQuery({
    queryKey: ["orders", proj],
    queryFn: () => listOrders(proj),
    enabled: Boolean(proj),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["orders", proj] });
  const add = useMutation({
    mutationFn: () => addOrder(proj, supplyId, Number(qty) || 1),
    onSuccess: () => { setQty("1"); refresh(); },
  });
  const addCat = useMutation({
    mutationFn: () => addSupply(newName, "ea"),
    onSuccess: () => { setNewName(""); queryClient.invalidateQueries({ queryKey: ["supplies"] }); },
  });
  const setStatus = useMutation({
    mutationFn: (a: { id: string; status: string }) => setOrderStatus(a.id, a.status),
    onSuccess: refresh,
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Supplies</h1>
          <p className="muted" style={{ margin: 0 }}>
            Job pull lists + the company supply catalog.
          </p>
        </div>
        <BackChip fallback="/warehouse" label="Warehouse" />
      </header>

      <h2>Assign to job</h2>
      <div className="job-chip-row">
        {(projects.data ?? []).map((p) => (
          <button
            key={p.id}
            type="button"
            className={proj === p.id ? "job-chip active" : "job-chip"}
            onClick={() => setProj(p.id)}
          >
            {p.job_code}
          </button>
        ))}
      </div>

      {proj && (
        <>
          <div className="detail-card">
            <label className="field-label">Add to pull list</label>
            <select value={supplyId} onChange={(e) => setSupplyId(e.target.value)}>
              <option value="">— supply —</option>
              {(supplies.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" />
            <button className="action-btn primary" disabled={add.isPending || !supplyId} onClick={() => add.mutate()}>
              Add to job
            </button>
          </div>

          <h2>Pull list</h2>
          <ul className="unit-list work-list">
            {(orders.data ?? []).map((o) => (
              <li key={o.id} className="find-row">
                <div>
                  <strong>{o.supplies?.name ?? o.name}</strong>{" "}
                  <span className="muted">×{o.qty}</span>
                </div>
                <select
                  style={{ marginLeft: "auto", maxWidth: 130, marginBottom: 0 }}
                  value={o.status}
                  onChange={(e) => setStatus.mutate({ id: o.id, status: e.target.value })}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </li>
            ))}
            {orders.data?.length === 0 && <p className="muted">Nothing on the pull list yet.</p>}
          </ul>
        </>
      )}

      <h2>Add to catalog</h2>
      <div className="detail-card">
        <div className="manual-entry">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New supply type" />
          <button className="primary" disabled={addCat.isPending || !newName.trim()} onClick={() => addCat.mutate()}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
