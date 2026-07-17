import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getMyProfile } from "../lib/install/api";
import { isLeadLike } from "../lib/install/types";
import { listInstalledForQc, setQc } from "../lib/ops";
import { addPriorityTerm } from "../lib/learn";

export function Qc() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const lead = isLeadLike(me.data?.role);
  const rows = useQuery({ queryKey: ["qcRows"], queryFn: listInstalledForQc, enabled: lead });

  const decide = useMutation({
    mutationFn: (a: { id: string; status: "passed" | "callback" }) => setQc(a.id, a.status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["qcRows"] }),
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
        <h1>Quality</h1>
        <Link to="/" className="button-like">Home</Link>
      </header>
      <p className="muted">
        The mock-up is the standard — match it every opening. Pass installs or log
        a callback; callbacks push their terms into the crew's learning decks.
      </p>

      <ul className="unit-list">
        {list.map((o) => {
          const status = o.qc?.status ?? "pending";
          return (
            <li key={o.id} className="find-row">
              <div>
                <strong>{o.opening_code}</strong>{" "}
                <span className="muted">{o.window_types?.type_code}</span>
                <div className={status === "passed" ? "ok" : status === "callback" ? "error" : "muted"} style={{ fontSize: 12 }}>
                  {status}
                </div>
              </div>
              <div className="row-gap" style={{ marginLeft: "auto" }}>
                <button className="button-like active-pill" onClick={() => decide.mutate({ id: o.id, status: "passed" })}>Pass ✓</button>
                <button
                  className="button-like"
                  onClick={async () => {
                    decide.mutate({ id: o.id, status: "callback" });
                    const term = prompt("Root-cause term id to push to crew decks (e.g. sill, flashtape)?");
                    if (term) await addPriorityTerm(term.trim(), `callback on ${o.opening_code}`);
                  }}
                >
                  Callback
                </button>
              </div>
            </li>
          );
        })}
        {list.length === 0 && <p className="muted">No installed openings to review.</p>}
      </ul>
    </div>
  );
}
