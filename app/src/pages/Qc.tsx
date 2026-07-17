import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { getMyProfile } from "../lib/install/api";
import { isLeadLike } from "../lib/install/types";
import { listInstalledForQc, setQc } from "../lib/ops";
import { addPriorityTerm } from "../lib/learn";
import { resolvePendingPoints } from "../lib/points";
import { CATS, TERMS } from "../lib/glossary";
import { pushToast } from "../lib/toast";

export function Qc() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const lead = isLeadLike(me.data?.role);
  const rows = useQuery({ queryKey: ["qcRows"], queryFn: listInstalledForQc, enabled: lead });

  // Which opening is mid-callback (awaiting a root-cause term), and the picked term.
  const [callbackFor, setCallbackFor] = useState<{ id: string; code: string } | null>(null);
  const [rootTerm, setRootTerm] = useState("");

  const decide = useMutation({
    mutationFn: async (a: { id: string; status: "passed" | "callback" }) => {
      await setQc(a.id, a.status);
      // Pass confirms the installer's pending points; callback voids them.
      await resolvePendingPoints(a.id, a.status === "passed" ? "confirmed" : "void");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["qcRows"] });
      queryClient.invalidateQueries({ queryKey: ["ledger"] });
      queryClient.invalidateQueries({ queryKey: ["pointsLeaderboard"] });
    },
  });

  const logCallback = useMutation({
    mutationFn: async (a: { id: string; code: string; term: string }) => {
      await decide.mutateAsync({ id: a.id, status: "callback" });
      if (a.term) await addPriorityTerm(a.term, `callback on ${a.code}`);
    },
    onSuccess: () => {
      pushToast("Callback logged — root cause pushed to crew decks.");
      setCallbackFor(null);
      setRootTerm("");
    },
  });

  if (me.data && !lead) {
    return (
      <div className="page">
        <header className="page-header"><h1>Quality</h1><Link to="/" className="button-like">Home</Link></header>
        <p className="muted">QC sign-off is for foremen and up.</p>
      </div>
    );
  }

  const list = rows.data ?? [];
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Quality</h1>
          <p className="muted" style={{ margin: 0 }}>
            Pass installs or log a callback — callbacks push terms into learning decks.
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">‹</Link>
      </header>

      <ul className="unit-list work-list">
        {list.map((o) => {
          const status = o.qc?.status ?? "pending";
          return (
            <li key={o.id} className="find-row" style={{ flexWrap: "wrap" }}>
              <div>
                <strong>{o.opening_code}</strong>{" "}
                <span className="muted">{o.window_types?.type_code}</span>
                <div className={status === "passed" ? "ok" : status === "callback" ? "error" : "muted"} style={{ fontSize: 12 }}>
                  {status}
                </div>
              </div>
              <div className="row-gap" style={{ marginLeft: "auto" }}>
                <button className="button-like qc-pass" onClick={() => decide.mutate({ id: o.id, status: "passed" })}>Pass ✓</button>
                <button
                  className="button-like qc-callback"
                  onClick={() => {
                    setCallbackFor({ id: o.id, code: o.opening_code });
                    setRootTerm("");
                  }}
                >
                  Callback
                </button>
              </div>
              {callbackFor?.id === o.id && (
                <div className="detail-card" style={{ marginTop: 8, width: "100%" }}>
                  <label className="field-label">Root-cause term (pushed to crew decks)</label>
                  <select value={rootTerm} onChange={(e) => setRootTerm(e.target.value)}>
                    <option value="">— pick a term —</option>
                    {CATS.map((c) => (
                      <optgroup key={c.id} label={c.label}>
                        {TERMS.filter((t) => t.cat === c.id).map((t) => (
                          <option key={t.id} value={t.id}>{t.term}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <div className="row-gap">
                    <button
                      className="primary big"
                      disabled={logCallback.isPending}
                      onClick={() => logCallback.mutate({ id: o.id, code: o.opening_code, term: rootTerm })}
                    >
                      Log callback
                    </button>
                    <button className="button-like" onClick={() => setCallbackFor(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {list.length === 0 && <p className="muted">No installed openings to review.</p>}
      </ul>
    </div>
  );
}
