import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  decideAccessRequest,
  getMyProfile,
  listAccessRequests,
} from "../lib/install/api";
import { isAdmin } from "../lib/install/types";

export function Admin() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const requests = useQuery({
    queryKey: ["accessRequests"],
    queryFn: listAccessRequests,
    enabled: isAdmin(me.data?.role),
  });

  const decide = useMutation({
    mutationFn: (args: { id: string; status: "approved" | "denied" }) =>
      decideAccessRequest(args.id, args.status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accessRequests"] }),
  });

  if (me.data && !isAdmin(me.data.role)) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Admin</h1>
          <Link to="/" className="button-like">Home</Link>
        </header>
        <p className="muted">Admin is for admins and the Big Boss.</p>
      </div>
    );
  }

  const pending = (requests.data ?? []).filter((r) => r.status === "pending");
  const decided = (requests.data ?? []).filter((r) => r.status !== "pending");

  return (
    <div className="page">
      <header className="page-header">
        <h1>Admin</h1>
        <Link to="/" className="button-like">Home</Link>
      </header>
      <p className="muted">Accounts, approvals and the AI connection.</p>

      <h2>Access requests ({pending.length})</h2>
      {pending.length === 0 && <p className="muted">No pending requests.</p>}
      <ul className="unit-list">
        {pending.map((r) => (
          <li key={r.id} className="find-row">
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
                className="button-like active-pill"
                onClick={() => decide.mutate({ id: r.id, status: "approved" })}
              >
                Approve ✓
              </button>
              <button
                className="button-like"
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
        <p>
          OpenAI powers transcription, tips, how-to and extraction. Set the
          <code> OPENAI_API_KEY</code> Edge Function secret in Supabase. If AI
          features show errors, the key is missing or out of quota.
        </p>
      </div>

      {decided.length > 0 && (
        <>
          <h2>Recent decisions</h2>
          <ul className="unit-list">
            {decided.slice(0, 10).map((r) => (
              <li key={r.id}>
                <strong>{r.name}</strong>{" "}
                <span className={r.status === "approved" ? "ok" : "error"}>
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
