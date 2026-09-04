import { BackChip } from "../components/BackChip";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  approveAccessRequest,
  decideAccessRequest,
  getMyProfile,
  isAlreadyHasLogin,
  listAccessRequests,
  listProfiles,
  markRequestAlreadyLinked,
  type AccessRequest,
  type ApprovedAccount,
} from "../lib/install/api";
import { formatApiError } from "../lib/errors";
import { isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";

/** "4 Sep" — enough to place a decision, short enough for a phone row. */
function decidedOn(at: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function Admin() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const requests = useQuery({
    queryKey: ["accessRequests"],
    queryFn: listAccessRequests,
    enabled: isSupervisorPlus(effectiveRole),
  });
  // Only to put a name on "who decided". A decision with an id nobody can
  // resolve still shows the date and the note — the roster is the nicety.
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: listProfiles,
    enabled: isSupervisorPlus(effectiveRole),
  });
  const nameOf = (id: string | null): string | null => {
    if (!id) return null;
    return (profiles.data ?? []).find((p) => p.id === id)?.display_name ?? null;
  };

  // Shown once, right after approval, and never fetched again — the password
  // exists nowhere else. Kept in page state deliberately rather than persisted.
  const [newAccount, setNewAccount] = useState<ApprovedAccount | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  // The request whose approval failed BECAUSE the person already has a login.
  // Until this existed, that request sat in Pending forever: Deny is a lie
  // about somebody who does work here, and there was nothing else to press.
  const [alreadyLinked, setAlreadyLinked] = useState<string | null>(null);
  // Which request's Deny is open, and the reason being typed into it.
  const [denying, setDenying] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState("");

  const approve = useMutation({
    mutationFn: (id: string) => approveAccessRequest(id),
    onSuccess: (account) => {
      setApproveError(null);
      setAlreadyLinked(null);
      setNewAccount(account);
      queryClient.invalidateQueries({ queryKey: ["accessRequests"] });
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (err, id) => {
      setNewAccount(null);
      setApproveError(formatApiError(err));
      // Read off the machine-readable code, never off the sentence.
      setAlreadyLinked(isAlreadyHasLogin(err) ? id : null);
    },
  });

  const decide = useMutation({
    mutationFn: (args: { id: string; status: "denied" | "pending"; note?: string }) =>
      decideAccessRequest(args.id, args.status, args.note),
    onSuccess: () => {
      setApproveError(null);
      setDenying(null);
      setDenyReason("");
      queryClient.invalidateQueries({ queryKey: ["accessRequests"] });
    },
    onError: (err) => setApproveError(formatApiError(err)),
  });

  const markLinked = useMutation({
    mutationFn: (id: string) => markRequestAlreadyLinked(id),
    onSuccess: () => {
      setApproveError(null);
      setAlreadyLinked(null);
      queryClient.invalidateQueries({ queryKey: ["accessRequests"] });
    },
    onError: (err) => setApproveError(formatApiError(err)),
  });

  if (me.data && !isSupervisorPlus(effectiveRole)) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Admin</h1>
          <BackChip fallback="/" label="Home" />
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
        <BackChip fallback="/" label="Home" />
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
                disabled={decide.isPending}
                onClick={() => {
                  setDenyReason("");
                  setDenying(denying === r.id ? null : r.id);
                }}
              >
                Deny
              </button>
            </div>

            {/* The one-tap answer to "they already have a login". Offered only
                on the row whose approval actually hit that, so it can never be
                pressed on a person who has no account. */}
            {alreadyLinked === r.id && (
              <div
                className="detail-card"
                data-testid="already-has-login"
                style={{ width: "100%", marginTop: 10 }}
              >
                <p style={{ margin: 0, lineHeight: 1.55 }}>
                  {r.name} already has a login, so there is nothing to create.
                  File this request as dealt with?
                </p>
                <div className="row-gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
                  <button
                    className="button-like button-like--primary"
                    data-testid="mark-already-has-login"
                    disabled={markLinked.isPending}
                    onClick={() => markLinked.mutate(r.id)}
                  >
                    {markLinked.isPending
                      ? "Filing…"
                      : "Mark as already has a login"}
                  </button>
                  <button className="link" onClick={() => setAlreadyLinked(null)}>
                    Leave it
                  </button>
                </div>
              </div>
            )}

            {/* Deny asks why. Optional on purpose: a reason nobody has to type
                is a reason that sometimes gets typed, and a required one is a
                box people paste "n/a" into. */}
            {denying === r.id && (
              <div
                className="detail-card"
                data-testid="deny-sheet"
                style={{ width: "100%", marginTop: 10 }}
              >
                <label className="field-label" htmlFor={`deny-why-${r.id}`}>
                  Why? — optional
                </label>
                <input
                  id={`deny-why-${r.id}`}
                  data-testid="deny-reason"
                  placeholder="e.g. not hiring right now"
                  value={denyReason}
                  onChange={(e) => setDenyReason(e.target.value)}
                />
                <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
                  Only people who can see this screen ever read it. It is here so
                  the next person to look knows what happened.
                </p>
                <div className="row-gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
                  <button
                    className="button-like qc-callback"
                    data-testid="deny-confirm"
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        id: r.id,
                        status: "denied",
                        note: denyReason,
                      })
                    }
                  >
                    {decide.isPending ? "Saving…" : "Deny this request"}
                  </button>
                  <button className="link" onClick={() => setDenying(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
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
              <DecidedRow
                key={r.id}
                request={r}
                decidedByName={nameOf(r.decided_by)}
                busy={decide.isPending}
                onReopen={() => decide.mutate({ id: r.id, status: "pending" })}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * One decision, read back.
 *
 * WHY THE NAME AND THE DATE ARE ON SCREEN. This list used to be a name and the
 * word DENIED, which answers none of the questions somebody actually has when
 * they look at it a fortnight later: who said no, when, and why. The row now
 * says all three, and offers the one repair that used to require asking the
 * person to fill the form in again — Re-open puts a denial back in the queue.
 */
function DecidedRow({
  request,
  decidedByName,
  busy,
  onReopen,
}: {
  request: AccessRequest;
  decidedByName: string | null;
  busy: boolean;
  onReopen: () => void;
}) {
  const when = decidedOn(request.decided_at);
  const trail = [decidedByName, when].filter(Boolean).join(" · ");
  return (
    <li className="find-row" style={{ flexWrap: "wrap" }}>
      <div>
        <strong>{request.name}</strong>
        {trail && (
          <div className="muted" style={{ fontSize: 12 }}>
            {request.status === "approved" ? "Approved by " : "Denied by "}
            {trail}
          </div>
        )}
        {request.decision_note && (
          <div
            className="muted"
            data-testid="decision-note"
            style={{ fontSize: 12, fontStyle: "italic" }}
          >
            “{request.decision_note}”
          </div>
        )}
      </div>
      <div className="row-gap" style={{ marginLeft: "auto", flexWrap: "wrap" }}>
        <span
          className={request.status === "approved" ? "ok" : "error"}
          style={{ fontWeight: 700, textTransform: "uppercase", fontSize: 12 }}
        >
          {request.status}
        </span>
        {/* Only a denial can be re-opened. An approval made an account, and
            putting that row back in the queue would offer to make a second. */}
        {request.status === "denied" && (
          <button
            className="button-like"
            data-testid="reopen-request"
            disabled={busy}
            onClick={onReopen}
          >
            Re-open
          </button>
        )}
      </div>
    </li>
  );
}
