import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  decideAccessRequest,
  getMyProfile,
  listAccessRequests,
} from "../lib/install/api";
import { isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";

export function Admin() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const requests = useQuery({
    queryKey: ["accessRequests"],
    queryFn: listAccessRequests,
    enabled: isSupervisorPlus(effectiveRole),
  });

  const decide = useMutation({
    mutationFn: (args: { id: string; status: "approved" | "denied" }) =>
      decideAccessRequest(args.id, args.status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accessRequests"] }),
  });

  if (me.data && !isSupervisorPlus(effectiveRole)) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Admin</h1>
          <Link to="/" className="back-chip" aria-label="Home">‹</Link>
        </header>
        <p className="muted">Admin is for supervisors and the owner.</p>
      </div>
    );
  }

  const pending = (requests.data ?? []).filter((r) => r.status === "pending");
  const decided = (requests.data ?? []).filter((r) => r.status !== "pending");

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Admin</h1>
          <p className="muted" style={{ margin: 0 }}>
            Accounts, approvals and the AI connection.
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">‹</Link>
      </header>

      <h2>Access requests ({pending.length})</h2>
      {pending.length === 0 && <p className="muted">No pending requests.</p>}
      <ul className="unit-list work-list">
        {pending.map((r) => (
          <li key={r.id} className="find-row" style={{ flexWrap: "wrap" }}>
            <div>
              <strong>{r.name}</strong>{" "}
              <span className="muted">{r.requested_role}</span>
              <div className="muted" style={{ fontSize: 12 }}>
                {[r.email, r.phone].filter(Boolean).join(" · ") || "no contact"}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                Once approved, create their login in Supabase Auth, then set their
                role on the Crew screen.
              </div>
            </div>
            <div className="row-gap" style={{ marginLeft: "auto" }}>
              <button
                className="button-like qc-pass"
                onClick={() => decide.mutate({ id: r.id, status: "approved" })}
              >
                Approve ✓
              </button>
              <button
                className="button-like qc-callback"
                onClick={() => decide.mutate({ id: r.id, status: "denied" })}
              >
                Deny
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h2>AI connection</h2>
      <div className="detail-card">
        <p style={{ margin: 0 }}>
          OpenAI powers transcription, tips, how-to and extraction. Set the
          <code> OPENAI_API_KEY</code> Edge Function secret in Supabase. If AI
          features show errors, the key is missing or out of quota.
        </p>
      </div>

      {decided.length > 0 && (
        <>
          <h2>Recent decisions</h2>
          <ul className="unit-list work-list">
            {decided.slice(0, 10).map((r) => (
              <li key={r.id} className="find-row">
                <strong>{r.name}</strong>
                <span
                  className={r.status === "approved" ? "ok" : "error"}
                  style={{ marginLeft: "auto", fontWeight: 700, textTransform: "uppercase", fontSize: 12 }}
                >
                  {r.status}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
