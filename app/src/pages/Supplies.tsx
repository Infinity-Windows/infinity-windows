import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
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
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const supplies = useQuery({ queryKey: ["supplies"], queryFn: listSupplies });
  const [proj, setProj] = useState("");
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
        <h1>Supplies</h1>
        <Link to="/" className="button-like">Home</Link>
      </header>
      <p className="muted">Job pull lists + the company supply catalog.</p>

      <label className="field-label">Job</label>
      <select value={proj} onChange={(e) => setProj(e.target.value)}>
        <option value="">— pick a job —</option>
        {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.job_code} — {p.name}</option>)}
      </select>

      {proj && (
        <>
          <div className="detail-card">
            <label className="field-label">Add to pull list</label>
            <select value={supplyId} onChange={(e) => setSupplyId(e.target.value)}>
              <option value="">— supply —</option>
              {(supplies.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" />
            <button className="action-btn" disabled={add.isPending || !supplyId} onClick={() => add.mutate()}>Add to job</button>
          </div>

          <h2>Pull list</h2>
          <ul className="unit-list">
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
      <div className="manual-entry">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New supply type" />
        <button disabled={addCat.isPending || !newName.trim()} onClick={() => addCat.mutate()}>Add</button>
      </div>
    </div>
  );
}
