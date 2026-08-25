// App suggestions (owner ask, 2026-08-25): every role's direct line about
// the APP itself — "this is broken", "it should do this". Reports land on
// the owners' list and nowhere else; the sender keeps their own thread so
// they can watch the status change. The database decides who sees what
// (RLS), so one query serves both views.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BackChip } from "../components/BackChip";
import { formatApiError } from "../lib/errors";
import {
  listAppFeedback,
  resolveAppFeedback,
  submitAppFeedback,
} from "../lib/appFeedback";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { isOwner } from "../lib/install/types";
import { listProfiles } from "../lib/install/api";

export function Suggestions() {
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const owner = isOwner(effectiveRole);
  const [kind, setKind] = useState<"bug" | "idea">("bug");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const feedback = useQuery({ queryKey: ["appFeedback"], queryFn: listAppFeedback });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const nameOf = new Map((profiles.data ?? []).map((p) => [p.id, p.display_name]));

  const submit = useMutation({
    mutationFn: () => submitAppFeedback(kind, body.trim()),
    onSuccess: () => {
      setBody("");
      setMessage("Sent — it's on the owners' list.");
      void qc.invalidateQueries({ queryKey: ["appFeedback"] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const resolve = useMutation({
    mutationFn: (id: string) => resolveAppFeedback(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["appFeedback"] }),
    onError: (e) => setMessage(formatApiError(e)),
  });

  const rows = (feedback.data ?? []).filter(
    (f) => showResolved || f.status === "open",
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{owner ? "App issues" : "Suggestions"}</p>
          <h1>Make the app better</h1>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>

      <p className="muted">
        Something broken? Something the app should do? Say it here — every
        report goes straight to the owners.
      </p>

      <div className="row-gap" style={{ marginBottom: 6 }}>
        <button
          className={kind === "bug" ? "button-like active-pill" : "button-like"}
          onClick={() => setKind("bug")}
        >
          Something's broken
        </button>
        <button
          className={kind === "idea" ? "button-like active-pill" : "button-like"}
          onClick={() => setKind("idea")}
        >
          An idea
        </button>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          kind === "bug"
            ? "What happened, and what were you doing when it happened?"
            : "What should the app do?"
        }
        rows={3}
        maxLength={2000}
        style={{ width: "100%", maxWidth: 560 }}
        aria-label="Your report"
      />
      <div className="row-gap" style={{ marginTop: 6 }}>
        <button
          className="primary"
          disabled={!body.trim() || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Sending…" : "Send to the owners"}
        </button>
      </div>
      {message && <p className="scanner-hint">{message}</p>}

      <div className="row-between" style={{ alignItems: "center", marginTop: 16 }}>
        <h2 style={{ margin: 0 }}>
          {owner ? `App issues (${rows.length})` : "Your reports"}
        </h2>
        <button className="link" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? "Hide resolved" : "Show resolved"}
        </button>
      </div>
      <ul className="unit-list">
        {rows.map((f) => (
          <li key={f.id} className="opening-review-row">
            <div className="row-gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
              <span className={f.kind === "bug" ? "warn-text" : "ok"}>
                {f.kind === "bug" ? "Broken" : "Idea"}
              </span>
              {owner && (
                <span className="muted">
                  {f.author ? (nameOf.get(f.author) ?? "someone") : "someone"}
                </span>
              )}
              <span className="muted">
                {new Date(f.created_at).toLocaleDateString([], {
                  month: "short",
                  day: "numeric",
                })}
              </span>
              {f.status === "resolved" && <span className="ok">resolved</span>}
              {owner && f.status === "open" && (
                <button
                  className="link"
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate(f.id)}
                >
                  Resolve
                </button>
              )}
            </div>
            <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{f.body}</p>
          </li>
        ))}
      </ul>
      {rows.length === 0 && (
        <p className="muted">
          {owner ? "Nothing open. The app is perfect — for now." : "Nothing yet."}
        </p>
      )}
    </div>
  );
}
