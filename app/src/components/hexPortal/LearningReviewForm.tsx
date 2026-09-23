import { useEffect, useId, useRef, useState } from "react";
import { formatApiError } from "../../lib/errors";
import { drain } from "../../lib/offline/outbox";
import { saveLearningCase, type LearningDraft } from "../../lib/hexPortal";
import {
  draftSaveFailed, findReviewers, getLearningReview, isStaleRevision, LearningUnavailable, OtherAccountError, saveLearningDraft, sendCheck,
  submitLearningReview, supersedeFailedDrafts, type LearningReview, type ReviewState,
} from "../../lib/hexLearning";
import { sessionUserIs } from "../../lib/fieldAsk";
import {
  LEARNING_HEADINGS, emptyLearningContent, missingHeadings, normalizeLearning, sendBlocker,
  type LearningContent, type LearningHeading, type ReviewerChoice, type ReviewerLookup,
} from "../../../../supabase/functions/_shared/learningTools";
import { VoiceTextarea } from "../voice/VoiceTextarea";
import { useLearningT, type LearningKey } from "./learningCatalog";
import { breakdownText } from "./learningText";

/** Where the write-up's evidence lives: a case already saved, or the Ask
 * exchange to save as one first (its words stay the case's question/answer). */
export type LearningSource = { caseId: string } | { newCase: LearningDraft };

/** The ids a write-up prepared in Ask was saved under, kept per account on this
 * phone so a reload or a later message never files the same lesson twice. */
interface KeptIds { caseId: string; reviewId: string; caseQueued: boolean }
const keptKey = (actorId: string, key: string) => `forge.learning.${actorId}.${key}`;
function readKept(actorId: string, key?: string): KeptIds | null {
  if (!key) return null;
  try {
    const v = JSON.parse(localStorage.getItem(keptKey(actorId, key)) ?? "null") as KeptIds | null;
    return v && typeof v.caseId === "string" && typeof v.reviewId === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * The author's write-up: the five headings as a checklist, Unknown as an
 * explicit answer, the reviewer chosen by exact person, and a state line that
 * never says more than the server or the phone's queue has confirmed.
 *
 * Send is an exact preview: it submits only when the server holds exactly the
 * revision and words on this screen. Anything else — another screen's edit, a
 * save that failed — stops and shows the latest to review first.
 */
export function LearningReviewForm({ actorId, projectId, source, review, initial, requestId, sourceRequestIds, unitId, via, initialReviewer, onChanged, keepKey }: {
  actorId: string; projectId: string; source: LearningSource; review?: LearningReview | null; initial?: LearningContent;
  requestId?: string | null; sourceRequestIds?: string[] | null; unitId?: string | null; via: "form" | "ask"; initialReviewer?: ReviewerLookup | null;
  onChanged?: () => void; keepKey?: string;
}) {
  const t = useLearningT();
  const fieldId = useId();
  const [kept] = useState(() => readKept(actorId, keepKey));
  const reviewId = useRef(review?.id ?? kept?.reviewId ?? crypto.randomUUID());
  const caseId = useRef("caseId" in source ? source.caseId : kept?.caseId ?? crypto.randomUUID());
  const caseQueued = useRef("caseId" in source || !!kept?.caseQueued);
  const userEdited = useRef(false);
  // Bumped by every keystroke: an async save may only settle the screen it started from.
  const editGen = useRef(0);
  const saving = useRef(false);
  const searchSeq = useRef(0);
  // Set in the effect, not only at creation: StrictMode runs setup, cleanup and
  // setup again, and a ref cleared by that first cleanup must come back.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const lastEntry = useRef<string | undefined>(undefined);
  // The revision the next queued save expects: the server's, plus saves still on the phone.
  const nextExpected = useRef(review?.revision ?? 0);
  const sendAction = useRef(crypto.randomUUID());
  const [content, setContent] = useState<LearningContent>(() => review?.content ?? initial ?? emptyLearningContent());
  const [dirty, setDirty] = useState(!review);
  const [server, setServer] = useState<LearningReview | null>(review ?? null);
  const [queued, setQueued] = useState(false);
  const [conflict, setConflict] = useState<LearningReview | null>(null);
  // The author's own words a "Show the latest version" replaced, kept to copy.
  const [replaced, setReplaced] = useState<LearningContent | null>(null);
  const [lookup, setLookup] = useState<ReviewerLookup | null>(initialReviewer ?? null);
  // An exact single match, or the reviewer who asked for changes, starts selected;
  // sending is still the author's tap.
  const [chosen, setChosen] = useState<Pick<ReviewerChoice, "id" | "name"> | null>(initialReviewer?.status === "exact" ? initialReviewer.match
    : review?.state === "changes_requested" && review.reviewer?.available ? review.reviewer : null);
  const [search, setSearch] = useState(initialReviewer?.said ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const state: ReviewState | null = server?.state ?? null;
  const editable = state === null || state === "draft" || state === "changes_requested";
  const missing = missingHeadings(content);

  const edit = (next: Partial<LearningContent>) => {
    userEdited.current = true; editGen.current += 1;
    setContent((c) => ({ ...c, ...next })); setDirty(true); setError("");
  };
  const setUnknown = (h: LearningHeading, unknown: boolean) => edit({
    unknown: unknown ? [...content.unknown, h] : content.unknown.filter((x) => x !== h),
    ...(unknown ? { [h]: null, ...(h === "impact" ? { impact_minutes: null, impact_cost_cents: null } : {}) } : {}),
  });
  const fail = (e: unknown) => alive.current && setError(e instanceof OtherAccountError ? t("learn.otherAccount") : e instanceof LearningUnavailable ? t("learn.unavailable")
    : isStaleRevision(e) ? t("learn.stale") : formatApiError(e));

  /** What the server holds now. Caught up: the queue has landed. Ahead: another
   * screen changed it — shown as a conflict, never silently adopted. */
  const refresh = async (adopt = false) => {
    try {
      const latest = await getLearningReview(reviewId.current);
      if (!alive.current) return latest;
      setServer(latest);
      if (adopt || latest.revision === nextExpected.current) { nextExpected.current = latest.revision; setQueued(false); }
      else if (latest.revision > nextExpected.current) setConflict(latest);
      return latest;
    } catch {
      return null;
    }
  };

  /**
   * Take the server's latest into the form, to review before anything else. This
   * tap is the author's explicit choice to supersede their own failed saves of
   * this write-up; nothing else in the queue is touched. Their words stay visible.
   */
  const reloadLatest = async () => {
    if (!conflict || busy) return;
    const latest = conflict, mine = content;
    setBusy(true);
    try {
      const dropped = await supersedeFailedDrafts(reviewId.current, actorId).catch(() => []);
      if (!alive.current) return;
      setReplaced(dropped[0] ?? mine);
      lastEntry.current = undefined;
      nextExpected.current = latest.revision; userEdited.current = false; editGen.current += 1;
      setContent(latest.content); setServer(latest); setDirty(false); setQueued(false); setConflict(null); setError("");
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  // Coming back to a write-up saved from Ask: what the server holds is the truth.
  useEffect(() => {
    if (kept) void refresh(true).then((latest) => { if (latest && alive.current && !userEdited.current) { setContent(latest.content); setDirty(false); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A later message's answers fill the form until the person starts typing.
  const firstInitial = useRef(initial);
  useEffect(() => {
    if (!initial || initial === firstInitial.current || userEdited.current || !editable) return;
    editGen.current += 1;
    setContent(initial); setDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  async function save(): Promise<boolean> {
    // One save at a time: two taps must not queue two saves at the same revision.
    if (saving.current || conflict) return false;
    let normalized: LearningContent;
    try { normalized = normalizeLearning(content); } catch (e) { setError(formatApiError(e)); return false; }
    const gen = editGen.current;
    saving.current = true;
    try {
      if (!caseQueued.current && "newCase" in source) {
        lastEntry.current = await saveLearningCase(source.newCase, caseId.current);
        caseQueued.current = true;
        if (keepKey) try {
          localStorage.setItem(keptKey(actorId, keepKey), JSON.stringify({ caseId: caseId.current, reviewId: reviewId.current, caseQueued: true } satisfies KeptIds));
        } catch { /* the queue still holds the save */ }
      }
      lastEntry.current = await saveLearningDraft({ actorId, reviewId: reviewId.current, caseId: caseId.current, expectedRevision: nextExpected.current,
        content: normalized, requestId, sourceRequestIds, unitId, via }, lastEntry.current);
      nextExpected.current += 1;
      if (!alive.current) return true;
      setQueued(true);
      // Typing that happened while this was queuing is newer: keep it, still unsaved.
      if (editGen.current === gen) { setContent(normalized); setDirty(false); }
      void drain().then(() => refresh()).then(() => onChanged?.());
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      saving.current = false;
    }
  }

  async function send() {
    if (busy || conflict) return;
    const blocker = sendBlocker(content);
    if (blocker) { setError(t(blocker === "missing" ? "learn.sendBlockedMissing" : "learn.sendBlockedIssue")); return; }
    if (!chosen) { setError(t("learn.reviewerRequired")); return; }
    if (typeof navigator !== "undefined" && navigator.onLine === false) { setError(t("learn.sendNeedsConnection")); return; }
    setBusy(true); setError("");
    try {
      if (dirty && editable && !(await save())) return;
      // The exact words the author is sending, as they stand at this tap.
      const reviewed = normalizeLearning(content);
      const gen = editGen.current;
      await drain();
      const latest = await getLearningReview(reviewId.current).catch(() => null);
      if (!alive.current) return;
      if (!latest) { setError(t("learn.sendWaitSync")); return; }
      setServer(latest);
      const failedSave = await draftSaveFailed(reviewId.current);
      // Every await above is a chance for the screen, the words or the account
      // to change: check all three again right before the one write.
      if (!alive.current) return;
      if (!(await sessionUserIs(actorId))) { if (alive.current) setError(t("learn.otherAccount")); return; }
      if (!alive.current) return;
      const verdict = sendCheck({ expected: nextExpected.current, reviewed, latest, failedSave });
      if (verdict === "wait_sync") { setError(t("learn.sendWaitSync")); return; }
      if (verdict === "conflict" || editGen.current !== gen) { setConflict(latest); setError(t("learn.conflict")); return; }
      const sent = await submitLearningReview(actorId, reviewId.current, sendAction.current, latest.revision, chosen.id);
      sendAction.current = crypto.randomUUID();
      nextExpected.current = sent.revision;
      if (!alive.current) return;
      setServer(sent); setQueued(false);
      onChanged?.();
    } catch (e) {
      fail(e);
      if (isStaleRevision(e)) void refresh();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function find() {
    setError("");
    // Only the latest search may fill the list.
    const seq = ++searchSeq.current;
    try {
      const found = await findReviewers(projectId, search);
      if (!alive.current || seq !== searchSeq.current) return;
      setLookup(found);
      setChosen(found.status === "exact" ? found.match : null);
    } catch (e) {
      if (seq === searchSeq.current) fail(e);
    }
  }

  const reviewerName = server?.reviewer?.name ?? "";
  const stateLine = queued ? t("learn.state.local")
    : state === null ? t("learn.state.unsaved")
    : state === "draft" ? t("learn.state.draft")
    : t(`learn.state.${state}`, { name: reviewerName });
  const canResend = state === "submitted" && !!chosen && chosen.id !== server?.reviewer?.id;

  return (
    <section className="hex-learning-card learning-review" aria-label={t("learn.title")}>
      <h3>{t("learn.title")}</h3>
      <p className="learning-state" role="status">{stateLine}</p>
      {via === "ask" && editable && <p className="muted">{t("learn.fromAsk")}</p>}
      {state === "changes_requested" && server?.last_note && (
        <p className="learning-note"><strong>{t("learn.reviewerNote")}:</strong> {server.last_note}</p>
      )}
      {state === "submitted" && server?.reviewer && !server.reviewer.available && (
        <p role="alert">{t("learn.reviewerGone", { name: server.reviewer.name })}</p>
      )}
      {conflict && (
        <div className="learning-conflict" role="alert">
          <p>{t("learn.conflict")}</p>
          <button type="button" className="btn" disabled={busy} onClick={() => void reloadLatest()}>{t("learn.reloadLatest")}</button>
        </div>
      )}
      {replaced && (
        <details className="learning-replaced">
          <summary>{t("learn.replacedWords")}</summary>
          <p className="learning-breakdown">{breakdownText(t, replaced)}</p>
        </details>
      )}
      {editable ? (
        <>
          <p className="muted">{t("learn.help")} {t("learn.privacy")}</p>
          <p className={missing.length ? "learning-missing" : "muted"}>
            {missing.length ? t("learn.missing", { count: missing.length }) : t("learn.complete")}
          </p>
          <ol className="learning-headings">
            {LEARNING_HEADINGS.map((h) => {
              const unknown = content.unknown.includes(h);
              const id = `${fieldId}-${h}`;
              return (
                <li key={h} className={`learning-heading${missing.includes(h) ? " learning-heading-missing" : ""}`}>
                  <label htmlFor={id}>{t(`learn.heading.${h}` as LearningKey)}</label>
                  <VoiceTextarea id={id} rows={3} maxLength={4000} disabled={unknown}
                    value={unknown ? "" : content[h] ?? ""} placeholder={unknown ? t("learn.unknown") : ""}
                    onChange={(e) => edit({ [h]: e.target.value })} />
                  {h === "impact" && !unknown && (
                    <div className="learning-impact">
                      <label>{t("learn.impactMinutes")}
                        <input type="number" inputMode="numeric" min={0} step={1} value={content.impact_minutes ?? ""}
                          onChange={(e) => edit({ impact_minutes: e.target.value === "" ? null : Math.trunc(Number(e.target.value)) })} />
                      </label>
                      <label>{t("learn.impactCost")}
                        <input type="number" inputMode="decimal" min={0} step={0.01}
                          value={content.impact_cost_cents === null ? "" : content.impact_cost_cents / 100}
                          onChange={(e) => edit({ impact_cost_cents: e.target.value === "" ? null : Math.round(Number(e.target.value) * 100) })} />
                      </label>
                      <p className="muted">{t("learn.impactNote")}</p>
                    </div>
                  )}
                  <label className="learning-unknown">
                    <input type="checkbox" checked={unknown} onChange={(e) => setUnknown(h, e.target.checked)} /> {t("learn.markUnknown")}
                  </label>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <p className="learning-breakdown">{breakdownText(t, content)}</p>
      )}
      {(editable || state === "submitted") && (
        <fieldset className="learning-reviewer">
          <legend>{t("learn.reviewer")}</legend>
          <div className="learning-reviewer-search">
            <input aria-label={t("learn.reviewerSearch")} placeholder={t("learn.reviewerSearch")} value={search} maxLength={100}
              onChange={(e) => { searchSeq.current += 1; setSearch(e.target.value); setLookup(null); setChosen(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void find(); } }} />
            <button type="button" className="btn" onClick={() => void find()}>{t("learn.reviewerFind")}</button>
          </div>
          {lookup && lookup.status === "exact" && lookup.match && <p className="muted">{t("learn.reviewerExact", { name: lookup.match.name })}</p>}
          {lookup && lookup.status === "choose" && <p role="alert">{t("learn.reviewerChoose", { name: lookup.said ?? search })}</p>}
          {lookup && lookup.status === "none" && <p role="alert">{t("learn.reviewerNone", { name: lookup.said ?? search })}</p>}
          {lookup && lookup.choices.length > 0 && (
            <ul className="learning-choices">
              {lookup.choices.map((c) => (
                <li key={c.id}>
                  <label>
                    <input type="radio" name={`${fieldId}-reviewer`} checked={chosen?.id === c.id} onChange={() => setChosen(c)} />
                    {c.name} · {t(`learn.role.${c.role}` as LearningKey)}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      )}
      <div className="hex-learning-actions">
        {editable && <button type="button" className="btn" disabled={busy || !!conflict} onClick={() => void save()}>{t("learn.save")}</button>}
        {(editable || canResend) && (
          <button type="button" className="btn btn-primary" disabled={busy || !!conflict} onClick={() => void send()}>
            {chosen ? t(canResend ? "learn.resend" : "learn.send", { name: chosen.name }) : t("learn.sendNeedsReviewer")}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
