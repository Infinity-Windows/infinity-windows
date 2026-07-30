import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  approveAccessRequest,
  decideAccessRequest,
  getMyProfile,
  listAccessRequests,
  type ApprovedAccount,
} from "../lib/install/api";
import { formatApiError } from "../lib/errors";
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

  // Shown once, right after approval, and never fetched again — the password
  // exists nowhere else. Kept in page state deliberately rather than persisted.
  const [newAccount, setNewAccount] = useState<ApprovedAccount | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  const approve = useMutation({
    mutationFn: (id: string) => approveAccessRequest(id),
    onSuccess: (account) => {
      setApproveError(null);
      setNewAccount(account);
      queryClient.invalidateQueries({ queryKey: ["accessRequests"] });
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (err) => {
      setNewAccount(null);
      setApproveError(formatApiError(err));
    },
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

      <h2>Add someone yourself</h2>
      <div className="detail-card">
        <p style={{ marginTop: 0 }}>
          You don't have to wait for someone to ask. Add a crew member by name,
          choose what they can do, and text them a code that sets up their login
          — no email needed.
        </p>
        <Link to="/access" className="button-like">
          Crew access →
        </Link>
      </div>

      <h2>Access requests ({pending.length})</h2>
      {pending.length === 0 && <p className="muted">No pending requests.</p>}
      {approveError && <p className="error">{approveError}</p>}
      {newAccount && (
        <div className="detail-card">
          <p style={{ margin: 0, fontWeight: 600 }}>
            {newAccount.display_name} can sign in now
          </p>
          <p className="muted" style={{ margin: "6px 0 10px", lineHeight: 1.55 }}>
            Give them these two things. The password is shown once and is not
            saved anywhere — they should change it after their first sign-in.
            They start as an Installer; change that on the Crew screen if they
            need more.
          </p>
          <p style={{ margin: 0 }}>
            Email: <code>{newAccount.email}</code>
          </p>
          <p style={{ margin: "4px 0 10px" }}>
            Password: <code>{newAccount.temporary_password}</code>
          </p>
          <div className="row-gap">
            <button
              className="secondary"
              onClick={() =>
                navigator.clipboard?.writeText(
                  `${newAccount.email} / ${newAccount.temporary_password}`,
                )
              }
            >
              Copy
            </button>
            <button className="link" onClick={() => setNewAccount(null)}>
              Done
            </button>
          </div>
        </div>
      )}
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
                Approving creates their login and gives you a one-time password
                to pass on. They start as an Installer.
              </div>
            </div>
            <div className="row-gap" style={{ marginLeft: "auto" }}>
              <button
                className="button-like qc-pass"
                disabled={approve.isPending}
                onClick={() => approve.mutate(r.id)}
              >
                {approve.isPending ? "Creating login..." : "Approve ✓"}
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

      <h2>What crew asked</h2>
      <div className="detail-card">
        <p style={{ marginTop: 0 }}>
          Every question asked of the company brain is logged, along with whether our own
          notes answered it. The unanswered ones tell you exactly what to write next, in
          crew's own words.
        </p>
        <Link to="/ask-misses" className="button-like">
          Read the questions →
        </Link>
      </div>

      <h2>AI connection</h2>
      <div className="detail-card">
        <p style={{ margin: 0 }}>
          Crew answers come from the company brain on the phone — no key, no cost per
          question, and it works with no signal. Everything the app writes — answers,
          how-tos, toolbox talks, window-type tips, reading plansets and delivery
          schedules — runs on Claude (<code>ANTHROPIC_API_KEY</code>). OpenAI is only
          used for three things it does better or that Claude cannot do at all: voice-memo
          transcription, document search, and the safety-talk diagrams
          (<code>OPENAI_API_KEY</code>). Both are Edge Function secrets. If those features
          show errors, a key is missing or that account is out of quota.
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
