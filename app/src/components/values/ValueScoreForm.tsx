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
import { useCallback, useEffect, useRef, useState } from "react";
import { useValuesT, type ValuesKey } from "../../lib/i18n/valuesCatalog";
import { VALUE_SLUGS, VALUE_RUBRICS, anchorBandFor, type CoreValueSlug } from "../../lib/values/rubric";
import { VALUE_RUBRICS_ES } from "../../lib/i18n/valuesCatalog";
import { useLanguage } from "../../lib/i18n/context";
import { enqueueValuesSubmit } from "../../lib/offline/outbox";
import { subscribe } from "../../lib/offline/outbox";
import { allValuesScored, loadValuesDraft, readValuesStatus, saveValuesDraft } from "../../lib/values/drafts";
import type { ValuesDraftRow } from "../../lib/offline/outboxStore";
import { hashValuesSubmission, normalizeValuesSubmission } from "../../lib/values/receiptContract";
import { signInMark, stillSignedInAs } from "../../lib/signedIn";

const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

// A promised owner-bound save belongs to the draft, not its mounted form.
// Keep writes ordered across close/reopen and wait for them before loading a
// replacement form. Unmount stops UI updates, never already-promised saves.
const draftWrites = new Map<string, Promise<void>>();
function writeDraft(draft: ValuesDraftRow): Promise<void> {
  const write = (draftWrites.get(draft.id) ?? Promise.resolve())
    .catch(() => undefined).then(() => saveValuesDraft(draft));
  draftWrites.set(draft.id, write);
  const cleanup = () => { if (draftWrites.get(draft.id) === write) draftWrites.delete(draft.id); };
  void write.then(cleanup, cleanup);
  return write;
}
async function loadAfterWrites(ownerId: string, assignmentId: string, rubricVersion: number) {
  await draftWrites.get(`${ownerId}:${assignmentId}`)?.catch(() => undefined);
  return loadValuesDraft(ownerId, assignmentId, rubricVersion);
}

export function ValueScoreForm({
  assignmentId,
  ownerId,
  rubricVersion,
  onDone,
}: {
  assignmentId: string;
  ownerId: string;
  /** From the task list — passed back unchanged; values_submit refuses a mismatch. */
  rubricVersion: number;
  onDone: () => void;
}) {
  const vt = useValuesT();
  const { lang } = useLanguage();
  const [draft, setDraft] = useState<ValuesDraftRow | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  const [saveState, setSaveState] = useState<"unsaved" | "saving" | "saved" | "failed">("unsaved");
  const pendingSave = useRef<Promise<void>>(Promise.resolve());
  const draftRef = useRef<ValuesDraftRow | null>(null);
  const editRevision = useRef(0);
  const formGeneration = useRef(0);
  const submitLocked = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const invalidatePendingReads = useCallback(() => { formGeneration.current++; }, []);

  useEffect(() => {
    let active = true;
    const generation = ++formGeneration.current;
    draftRef.current = null;
    pendingSave.current = Promise.resolve();
    submitLocked.current = false;
    setSending(false);
    setDraft(null);
    setError(false);
    setSaveState("unsaved");
    void loadAfterWrites(ownerId, assignmentId, rubricVersion).then((saved) => {
      if (active && formGeneration.current === generation && !draftRef.current) {
        draftRef.current = saved;
        setDraft(saved);
      }
    }).catch(() => { if (active) setError(true); });
    const unsubscribe = subscribe(() => {
      void loadAfterWrites(ownerId, assignmentId, rubricVersion).then((saved) => {
        if (active && formGeneration.current === generation) {
          // While editing, an unrelated clock/photo refresh must never put an
          // older IndexedDB snapshot over newer local answers.
          if (draftRef.current?.status === "editing" && saved.status === "editing") return;
          draftRef.current = saved;
          setDraft(saved);
          if (saved.status === "accepted") onDoneRef.current();
        }
      }).catch(() => { if (active) setError(true); });
    });
    return () => { active = false; invalidatePendingReads(); unsubscribe(); };
  }, [ownerId, assignmentId, rubricVersion, invalidatePendingReads]);

  const complete = draft ? allValuesScored(draft.scores) : false;

  function persist(next: ValuesDraftRow) {
    const generation = formGeneration.current;
    const revision = ++editRevision.current;
    draftRef.current = next;
    setDraft(next);
    setError(false);
    setSaveState("saving");
    pendingSave.current = writeDraft(next).then(() => {
      if (formGeneration.current === generation && editRevision.current === revision) setSaveState("saved");
    });
    void pendingSave.current.catch(() => {
      if (formGeneration.current === generation && editRevision.current === revision) setSaveState("failed");
    });
  }

  function setScore(slug: CoreValueSlug, score: number) {
    const current = draftRef.current;
    if (submitLocked.current || !current || current.status !== "editing") return;
    persist({ ...current, scores: { ...current.scores, [slug]: score } });
  }

  function setComment(comment: string) {
    const current = draftRef.current;
    if (submitLocked.current || !current || current.status !== "editing") return;
    persist({ ...current, comment });
  }

  function retrySave() {
    if (draftRef.current?.status === "editing") persist(draftRef.current);
  }

  async function submit() {
    const snapshot = draftRef.current;
    if (!snapshot || !allValuesScored(snapshot.scores) || submitLocked.current || saveState === "failed" || saveState === "saving" || (snapshot.status !== "editing" && snapshot.status !== "queued")) return;
    submitLocked.current = true;
    setSending(true);
    setError(false);
    const generation = formGeneration.current;
    const signIn = signInMark();
    try {
      await pendingSave.current;
      if (formGeneration.current !== generation || !stillSignedInAs(signIn, ownerId)) return;
      const scores = VALUE_SLUGS.map((slug) => ({ slug, score: snapshot.scores[slug]! }));
      const normalized = normalizeValuesSubmission({ assignmentId, requestId: snapshot.requestId, rubricVersion, scores, comment: snapshot.comment });
      const digest = await hashValuesSubmission(normalized);
      if (formGeneration.current !== generation || !stillSignedInAs(signIn, ownerId)) return;
      const queued = { ...snapshot, status: "queued" as const, digest };
      await writeDraft(queued);
      if (formGeneration.current !== generation || !stillSignedInAs(signIn, ownerId)) return;
      draftRef.current = queued;
      setDraft(queued);
      await enqueueValuesSubmit({
        requestId: snapshot.requestId,
        assignmentId,
        raterId: ownerId,
        rubricVersion,
        scores: normalized.scores,
        comment: normalized.comment,
        digest,
      });
      const latest = await readValuesStatus(ownerId, assignmentId);
      if (formGeneration.current === generation && stillSignedInAs(signIn, ownerId) && latest === "accepted") onDoneRef.current();
    } catch {
      if (formGeneration.current === generation) setError(true);
    } finally {
      if (formGeneration.current === generation) {
        submitLocked.current = false;
        setSending(false);
      }
    }
  }

  return (
    <div>
      {!draft && <p className="muted">{vt("values.form.loading")}</p>}
      {VALUE_SLUGS.map((slug) => {
        const rubric = lang === "es" ? { ...VALUE_RUBRICS[slug], ...VALUE_RUBRICS_ES[slug] } : VALUE_RUBRICS[slug];
        const score = draft?.scores[slug];
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
                  disabled={sending || !draft || draft.status !== "editing"}
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
          value={draft?.comment ?? ""}
          maxLength={2000}
          onChange={(e) => setComment(e.target.value)}
          disabled={sending || !draft || draft.status !== "editing"}
          style={{ width: "100%", minHeight: 80 }}
        />
      </section>

      {!complete && <p className="muted">{vt("values.form.incomplete")}</p>}
      {error && <p role="alert">{vt("values.form.saveError")}</p>}
      {draft?.status === "editing" && saveState === "saving" && <p className="muted">{vt("values.form.saving")}</p>}
      {draft?.status === "editing" && saveState === "saved" && <p className="muted">{vt("values.form.saved")}</p>}
      {draft?.status === "editing" && saveState === "failed" && <div><p role="alert">{vt("values.form.saveError")}</p><button type="button" className="button-like" onClick={retrySave}>{vt("values.form.retrySave")}</button></div>}
      {draft?.status === "queued" && <p className="muted">{vt("values.form.queued")}</p>}
      {draft?.status === "accepted" && <p className="muted">{vt("values.form.accepted")}</p>}
      {draft?.status === "conflict" && <p role="alert">{vt("values.form.conflict")}</p>}
      {draft?.status === "denied" && <p role="alert">{vt("values.form.notYours")}</p>}
      {draft?.status === "blocked" && <p role="alert">{vt("values.form.blocked")}</p>}

      <button type="button" className="action-btn" disabled={!complete || sending || error || saveState === "saving" || saveState === "failed" || draft?.status === "accepted" || draft?.status === "conflict" || draft?.status === "denied" || draft?.status === "blocked"} onClick={submit}>
        {sending ? vt("values.form.submitting") : vt("values.form.submit")}
      </button>
    </div>
  );
}
