/**
 * The eight-value scoring form for one assignment (20261106000000).
 *
 * No preselected score, no N/A — matching the pinned source exactly
 * (architecture brief: "no skip/not-observed... adding N/A would depart from
 * the pinned behavior"). Submit stays disabled until all eight are picked.
 * The write goes through the offline outbox: a stable request id survives a
 * dropped reply or an app restart, and a resend of the SAME id is answered
 * with the original receipt rather than a second submission.
 */
import { useState } from "react";
import { useValuesT, type ValuesKey } from "../../lib/i18n/valuesCatalog";
import { VALUE_SLUGS, VALUE_RUBRICS, anchorBandFor, type CoreValueSlug } from "../../lib/values/rubric";
import { VALUE_RUBRICS_ES } from "../../lib/i18n/valuesCatalog";
import { useLanguage } from "../../lib/i18n/context";
import { enqueueValuesSubmit } from "../../lib/offline/outbox";
import { supabase } from "../../lib/supabase";

const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

function draftKey(assignmentId: string): string {
  return `forge.values.draft.${assignmentId}`;
}

type Draft = { requestId: string; scores: Partial<Record<CoreValueSlug, number>>; comment: string };

function readDraft(assignmentId: string): Draft {
  try {
    const raw = localStorage.getItem(draftKey(assignmentId));
    if (raw) return JSON.parse(raw) as Draft;
  } catch {
    // Storage can be blocked or the draft corrupt — start fresh rather than crash.
  }
  return { requestId: crypto.randomUUID(), scores: {}, comment: "" };
}

function writeDraft(assignmentId: string, draft: Draft) {
  try {
    localStorage.setItem(draftKey(assignmentId), JSON.stringify(draft));
  } catch {
    // Best-effort — losing the draft loses convenience, not correctness: the
    // server-side request id/scores are only written on an actual submit.
  }
}

function clearDraft(assignmentId: string) {
  try {
    localStorage.removeItem(draftKey(assignmentId));
  } catch {
    /* ignore */
  }
}

export function ValueScoreForm({
  assignmentId,
  rubricVersion,
  onDone,
}: {
  assignmentId: string;
  /** From the task list — passed back unchanged; values_submit refuses a mismatch. */
  rubricVersion: number;
  onDone: () => void;
}) {
  const vt = useValuesT();
  const { lang } = useLanguage();
  const [draft, setDraft] = useState<Draft>(() => readDraft(assignmentId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  const complete = VALUE_SLUGS.every((s) => draft.scores[s] != null);

  function setScore(slug: CoreValueSlug, score: number) {
    const next = { ...draft, scores: { ...draft.scores, [slug]: score } };
    setDraft(next);
    writeDraft(assignmentId, next);
  }

  function setComment(comment: string) {
    const next = { ...draft, comment };
    setDraft(next);
    writeDraft(assignmentId, next);
  }

  async function submit() {
    if (!complete || sending) return;
    setSending(true);
    setError(null);
    try {
      const { data } = await supabase.auth.getUser();
      const raterId = data.user?.id;
      if (!raterId) throw new Error("Sign in before submitting a values review.");
      await enqueueValuesSubmit({
        requestId: draft.requestId,
        assignmentId,
        raterId,
        rubricVersion,
        scores: VALUE_SLUGS.map((slug) => ({ slug, score: draft.scores[slug]! })),
        comment: draft.comment.trim() || null,
      });
      clearDraft(assignmentId);
      setQueued(true);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      {VALUE_SLUGS.map((slug) => {
        const rubric = lang === "es" ? { ...VALUE_RUBRICS[slug], ...VALUE_RUBRICS_ES[slug] } : VALUE_RUBRICS[slug];
        const score = draft.scores[slug];
        const band = score != null ? anchorBandFor(score) : null;
        return (
          <section key={slug} className="detail-card" style={{ marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>{rubric.title}</h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{rubric.briefing}</p>
            <ul style={{ fontSize: 13 }}>
              {rubric.criteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
            <div className="row-gap" role="group" aria-label={rubric.title}>
              {SCORES.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={score === n ? "button-like active-pill" : "button-like"}
                  onClick={() => setScore(slug, n)}
                >
                  {n}
                </button>
              ))}
            </div>
            {band && (
              <p className="muted" style={{ fontSize: 12 }}>
                {vt(`values.form.anchor.${band}` as ValuesKey)}: {rubric.anchors[band]}
              </p>
            )}
            {score == null && <p className="muted" style={{ fontSize: 12 }}>{vt("values.form.unscored")}</p>}
          </section>
        );
      })}

      <section className="detail-card" style={{ marginBottom: 12 }}>
        <label htmlFor="values-comment">{vt("values.form.comment.label")}</label>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>{vt("values.form.comment.help")}</p>
        <textarea
          id="values-comment"
          value={draft.comment}
          maxLength={2000}
          onChange={(e) => setComment(e.target.value)}
          style={{ width: "100%", minHeight: 80 }}
        />
      </section>

      {!complete && <p className="muted">{vt("values.form.incomplete")}</p>}
      {error && <p role="alert">{error}</p>}
      {queued && <p className="muted">{vt("values.form.queued")}</p>}

      <button type="button" className="action-btn" disabled={!complete || sending} onClick={submit}>
        {sending ? vt("values.form.submitting") : vt("values.form.submit")}
      </button>
    </div>
  );
}
