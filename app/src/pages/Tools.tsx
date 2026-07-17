import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { getMyProfile, listProfiles } from "../lib/install/api";
import { isLeadLike } from "../lib/install/types";
import { addTool, listTools, setToolHolder } from "../lib/ops";

function dueSoon(date: string | null): boolean {
  if (!date) return false;
  const days = (new Date(date).getTime() - Date.now()) / 86400000;
  return days < 30;
}

export function Tools() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const lead = isLeadLike(me.data?.role);
  const tools = useQuery({ queryKey: ["tools"], queryFn: listTools });
  const crew = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const [name, setName] = useState("");
  const [due, setDue] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["tools"] });
  const add = useMutation({ mutationFn: () => addTool(name, due || null), onSuccess: () => { setName(""); setDue(""); refresh(); } });
  const setHolder = useMutation({
    mutationFn: (a: { id: string; holder: string | null }) => setToolHolder(a.id, a.holder),
    onSuccess: refresh,
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Tools</h1>
          <p className="muted" style={{ margin: 0 }}>
            Who has what — and what's due for calibration.
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">‹</Link>
      </header>

      <ul className="unit-list work-list">
        {(tools.data ?? []).map((t) => (
          <li key={t.id} className="find-row">
            <div>
              <strong>{t.name}</strong>
              <div className="muted" style={{ fontSize: 12 }}>
                {t.profiles?.display_name ? `With ${t.profiles.display_name}` : "In the shop"}
                {t.calibration_due && (
                  <span className={dueSoon(t.calibration_due) ? "warn-text" : ""}>
                    {" "}· calib due {t.calibration_due}
                  </span>
                )}
              </div>
            </div>
            {lead && (
              <select
                style={{ marginLeft: "auto", maxWidth: "45vw", marginBottom: 0 }}
                value={t.holder_id ?? ""}
                onChange={(e) => setHolder.mutate({ id: t.id, holder: e.target.value || null })}
              >
                <option value="">Shop</option>
                {(crew.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
              </select>
            )}
          </li>
        ))}
        {tools.data?.length === 0 && <p className="muted">No tools tracked yet.</p>}
      </ul>

      {lead && (
        <>
          <h2>Add a tool</h2>
          <div className="detail-card">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tool name" />
            <label className="field-label">Calibration due (optional)</label>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            <button className="primary big" disabled={add.isPending || !name.trim()} onClick={() => add.mutate()}>Add tool</button>
          </div>
        </>
      )}
    </div>
  );
}
