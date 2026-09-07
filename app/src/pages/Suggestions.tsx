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
import { isAutoFiledCrashReport } from "../lib/crashReport";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { isOwner } from "../lib/install/types";
import { listProfiles } from "../lib/install/api";
import { useT } from "../lib/i18n";

export function Suggestions() {
  const t = useT();
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
      setMessage(t("suggestions.sent"));
      void qc.invalidateQueries({ queryKey: ["appFeedback"] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const resolve = useMutation({
    mutationFn: (id: string) => resolveAppFeedback(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["appFeedback"] }),
    onError: (e) => setMessage(formatApiError(e)),
  });

  // A crash files its own bug row as whoever was holding the phone, so RLS
  // shows it back to them under "Your reports" — an English headline and a
  // JavaScript stack trace in a list of things they wrote. They did not write
  // it and cannot act on it, so it goes to the owners only; the crash screen
  // already gave them the five-character code to read out.
  const rows = (feedback.data ?? []).filter(
    (f) =>
      (showResolved || f.status === "open") &&
      (owner || !isAutoFiledCrashReport(f.body)),
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{owner ? t("suggestions.appIssues") : t("suggestions.title")}</p>
          <h1>{t("suggestions.heading")}</h1>
        </div>
        <BackChip fallback="/" label={t("suggestions.home")} />
      </header>

      <p className="muted">{t("suggestions.explain")}</p>

      <div className="row-gap" style={{ marginBottom: 6 }}>
        <button
          className={kind === "bug" ? "button-like active-pill" : "button-like"}
          onClick={() => setKind("bug")}
        >
          {t("suggestions.somethingBroken")}
        </button>
        <button
          className={kind === "idea" ? "button-like active-pill" : "button-like"}
          onClick={() => setKind("idea")}
        >
          {t("suggestions.anIdea")}
        </button>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          kind === "bug"
            ? t("suggestions.bugPlaceholder")
            : t("suggestions.ideaPlaceholder")
        }
        rows={3}
        maxLength={2000}
        style={{ width: "100%", maxWidth: 560 }}
        aria-label={t("suggestions.yourReport")}
      />
      <div className="row-gap" style={{ marginTop: 6 }}>
        <button
          className="primary"
          disabled={!body.trim() || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? t("suggestions.sending") : t("suggestions.sendToOwners")}
        </button>
      </div>
      {message && <p className="scanner-hint">{message}</p>}

      <div className="row-between" style={{ alignItems: "center", marginTop: 16 }}>
        <h2 style={{ margin: 0 }}>
          {owner ? t("suggestions.appIssuesCount", { n: rows.length }) : t("suggestions.yourReports")}
        </h2>
        <button className="link" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? t("suggestions.hideResolved") : t("suggestions.showResolved")}
        </button>
      </div>
      <ul className="unit-list">
        {rows.map((f) => (
          <li key={f.id} className="opening-review-row">
            <div className="row-gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
              <span className={f.kind === "bug" ? "warn-text" : "ok"}>
                {f.kind === "bug" ? t("suggestions.broken") : t("suggestions.idea")}
              </span>
              {owner && (
                <span className="muted">
                  {f.author ? (nameOf.get(f.author) ?? t("suggestions.someone")) : t("suggestions.someone")}
                </span>
              )}
              <span className="muted">
                {new Date(f.created_at).toLocaleDateString([], {
                  month: "short",
                  day: "numeric",
                })}
              </span>
              {f.status === "resolved" && <span className="ok">{t("suggestions.resolved")}</span>}
              {owner && f.status === "open" && (
                <button
                  className="link"
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate(f.id)}
                >
                  {t("suggestions.resolve")}
                </button>
              )}
            </div>
            <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{f.body}</p>
          </li>
        ))}
      </ul>
      {rows.length === 0 && (
        <p className="muted">
          {owner ? t("suggestions.nothingOpen") : t("suggestions.nothingYet")}
        </p>
      )}
    </div>
  );
}
