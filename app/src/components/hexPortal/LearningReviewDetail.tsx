import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { memoPlaybackUrl } from "../../lib/fieldAsk";
import {
  decideLearningReview, deliverLearningReview, findReviewers, getLearningReview, isStaleRevision, LearningUnavailable, OtherAccountError,
  reassignLearningReview, sendLearningWithdrawal, withdrawLearningReview,
  type Decision, type LearningReviewDetail as Detail,
} from "../../lib/hexLearning";
import type { ReviewerChoice, ReviewerLookup } from "../../../../supabase/functions/_shared/learningTools";
import { LearningReviewForm } from "./LearningReviewForm";
import { attemptText, breakdownText, deliveryText, when, withdrawalText } from "./learningText";
import { useLearningT, type LearningKey } from "./learningCatalog";

/** The recording comes from the author's own request row; storage decides whether
 * this reader may play it (speaker, supervisors, or the one named reviewer). */
function Recording({ path, label }: { path: string; label?: string }) {
  const t = useLearningT();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  const player = useRef<HTMLAudioElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const audio = player.current;
    return () => { if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); } };
  }, [url]);
  if (url) return <audio ref={player} className="field-memo" controls src={url} />;
  return (
    <>
      <button type="button" className="chip field-memo" onClick={() => void memoPlaybackUrl(path).then((u) => { if (alive.current) { if (u) setUrl(u); else setFailed(true); } })}>
        {label ?? t("learn.recording")}
      </button>
      {failed && <p className="muted">{t("learn.recordingUnavailable")}</p>}
    </>
  );
}

/** Choose one exact person; a search result only fills the list it was asked for. */
function PersonPicker({ projectId, reviewId, purpose, chosen, onChoose }: {
  projectId: string; reviewId: string; purpose: "forward" | "reassign"; chosen: ReviewerChoice | null; onChoose: (c: ReviewerChoice | null) => void;
}) {
  const t = useLearningT();
  const name = useId();
  const [search, setSearch] = useState("");
  const [lookup, setLookup] = useState<ReviewerLookup | null>(null);
  const seq = useRef(0);
  const find = async () => {
    const mine = ++seq.current;
    onChoose(null);
    try {
      const found = await findReviewers(projectId, search, purpose, reviewId);
      if (mine !== seq.current) return;
      setLookup(found);
      onChoose(found.status === "exact" ? found.match : null);
    } catch {
      if (mine === seq.current) setLookup({ status: "none", match: null, choices: [] });
    }
  };
  useEffect(() => { void find(); return () => { seq.current += 1; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="learning-reviewer">
      <div className="learning-reviewer-search">
        <input aria-label={t("learn.reviewerSearch")} placeholder={t("learn.reviewerSearch")} value={search} maxLength={100}
          onChange={(e) => { seq.current += 1; setSearch(e.target.value); setLookup(null); onChoose(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void find(); } }} />
        <button type="button" className="btn" onClick={() => void find()}>{t("learn.reviewerFind")}</button>
      </div>
      {lookup?.status === "choose" && <p role="alert">{t("learn.reviewerChoose", { name: search })}</p>}
      {lookup?.status === "none" && <p role="alert">{t("learn.reviewerNone", { name: search })}</p>}
      <ul className="learning-choices">
        {lookup?.choices.map((c) => (
          <li key={c.id}>
            <label>
              <input type="radio" name={name} checked={chosen?.id === c.id} onChange={() => onChoose(c)} />
              {c.name} · {t(`learn.role.${c.role}` as LearningKey)}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One write-up with its evidence and history. The author edits it while it is
 * theirs to change. The named reviewer asks for changes; a foreman forwards to a
 * named supervisor; a supervisor or owner approves (the named one, or as recorded
 * oversight), reassigns a stuck one with a reason, and withdraws. The server
 * decides who may do which; these buttons only follow the viewer flags it returns.
 */
export function LearningReviewDetail({ reviewId, actorId, onChanged }: { reviewId: string; actorId: string; onChanged?: () => void }) {
  const t = useLearningT();
  const noteId = useId(), reasonId = useId();
  const query = useQuery({ queryKey: ["hexLearningReview", reviewId, actorId], queryFn: () => getLearningReview(reviewId) });
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [oversight, setOversight] = useState(false);
  const [target, setTarget] = useState<ReviewerChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState("");
  // One stable id per intended action; a new one only after the server answered.
  const action = useRef(crypto.randomUUID());
  // Set in setup as well as cleared in cleanup, so StrictMode's double mount
  // does not leave every later answer ignored.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const changed = () => { void query.refetch(); onChanged?.(); };

  if (query.isLoading) return <p role="status">…</p>;
  if (query.error) return <p role="alert">{query.error instanceof LearningUnavailable ? t("learn.unavailable") : t("learn.loadFailed")}</p>;
  const r = query.data as Detail;
  const editable = r.viewer.is_author && (r.state === "draft" || r.state === "changes_requested");
  const waiting = r.state === "submitted";
  const named = r.viewer.is_reviewer;
  const oversee = !named && r.viewer.can_oversee;

  /** Run one tap. Late answers after leaving the screen change nothing here. */
  const run = async (step: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(""); setAttempt("");
    try {
      await step();
      action.current = crypto.randomUUID();
      if (!alive.current) return;
      setNote(""); setReason(""); setTarget(null);
      changed();
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof OtherAccountError ? t("learn.otherAccount") : isStaleRevision(e) ? t("learn.stale") : formatApiError(e));
      if (isStaleRevision(e)) void query.refetch();
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const decide = (decision: Decision) => run(async () => {
    const result = await decideLearningReview(actorId, r.id, action.current, r.revision, decision, note, oversee ? oversight : false);
    // Approved first becomes pending; the approver's tap then tries to deliver it.
    if (decision.kind === "approve" && result.state === "approved") {
      const sent = await deliverLearningReview(actorId, result).catch(() => null);
      if (sent && alive.current) setAttempt(attemptText(t, sent));
    }
  });
  const retry = () => run(async () => { const sent = await deliverLearningReview(actorId, r); if (alive.current) setAttempt(attemptText(t, sent)); });
  const retryRemoval = () => run(async () => { if (r.withdrawal) { const sent = await sendLearningWithdrawal(actorId, { case_id: r.case_id, withdrawal: r.withdrawal }); if (alive.current) setAttempt(attemptText(t, sent)); } });
  const withdraw = () => run(async () => {
    const result = await withdrawLearningReview(actorId, r.id, action.current, r.revision, reason);
    if (result.withdrawal) await sendLearningWithdrawal(actorId, { case_id: result.case_id, withdrawal: result.withdrawal }).catch(() => null);
  });

  const delivery = r.state === "approved" || r.state === "withdrawn" ? deliveryText(t, r.delivery) : null;
  const retryable = r.viewer.can_retry && r.delivery?.status !== "delivered";
  return (
    <article className="hex-learning-card learning-detail">
      <p className="muted">
        {r.job ? `${r.job.job_code ?? ""} · ${r.job.name}` : ""} · {r.unit_label || t("learn.wholeJob")} · {t("learn.author", { name: r.author.name })}
      </p>
      <details>
        <summary>{t("learn.original")}</summary>
        {r.sources.length > 0 && (
          <ol className="learning-sources" aria-label={t("learn.sources", { count: r.sources.length })}>
            {r.sources.map((q, i) => (
              <li key={q.id}>
                <span className="muted">{when(q.sent_at)}</span>
                <p className="learning-original">{q.transcript}</p>
                {q.audio_path && <Recording path={q.audio_path} label={t("learn.sourceRecording", { n: i + 1 })} />}
              </li>
            ))}
          </ol>
        )}
        <p className="learning-original">{r.case.question}</p>
        <p className="muted">{t("learn.originalAnswer")}</p>
        <p className="learning-original">{r.case.answer}</p>
      </details>
      {editable || (r.viewer.is_author && waiting) ? (
        // The author's own screen: edit, or re-send to someone else while it waits.
        <LearningReviewForm key={r.revision} actorId={actorId} projectId={r.project_id} source={{ caseId: r.case_id }} review={r} via={r.created_via} onChanged={changed} />
      ) : (
        <>
          <p className="learning-state" role="status">
            {r.state === "draft" ? t("learn.state.draft") : t(`learn.state.${r.state}` as LearningKey, { name: r.reviewer?.name ?? "" })}
          </p>
          {waiting && r.reviewer && !r.reviewer.available && <p role="alert">{t("learn.reviewerGone", { name: r.reviewer.name })}</p>}
          <p className="learning-breakdown">{breakdownText(t, r.content)}</p>
        </>
      )}
      {(r.state === "approved" || r.state === "withdrawn") && <p className="muted">{t("learn.approvalMeaning")}</p>}
      {delivery && <p role="status">{delivery}</p>}
      {r.state === "approved" && retryable && (
        <button type="button" className="btn" disabled={busy} onClick={() => void retry()}>{t("learn.retry")}</button>
      )}
      {r.state === "withdrawn" && r.withdrawal && (
        <>
          <p role="status">{withdrawalText(t, r.withdrawal)}</p>
          <p className="muted">{t("learn.withdrawal.reason", { name: r.withdrawal.withdrawn_by?.name ?? "—", reason: r.withdrawal.reason })}</p>
          {r.viewer.can_send_withdrawal && r.withdrawal.status !== "removed" && (
            <button type="button" className="btn" disabled={busy} onClick={() => void retryRemoval()}>{t("learn.retryRemoval")}</button>
          )}
        </>
      )}
      {attempt && <p role="status">{attempt}</p>}
      {waiting && (named || oversee) && (
        <div className="learning-decision">
          <p className="muted">{t("learn.approvalMeaning")}</p>
          <label htmlFor={noteId}>{t("learn.decisionNote")}</label>
          <textarea id={noteId} rows={3} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
          {oversee && (
            <>
              <p className="muted">{t("learn.notYours")}</p>
              <label className="learning-unknown">
                <input type="checkbox" checked={oversight} onChange={(e) => setOversight(e.target.checked)} /> {t("learn.asOversight")}
              </label>
            </>
          )}
          <div className="hex-learning-actions">
            <button type="button" className="btn" disabled={busy || (oversee && !oversight)} onClick={() => void decide({ kind: "request_changes" })}>{t("learn.requestChanges")}</button>
            {r.viewer.can_approve && (
              <button type="button" className="btn btn-primary" disabled={busy || (oversee && !oversight)} onClick={() => void decide({ kind: "approve" })}>{t("learn.approve")}</button>
            )}
          </div>
          {named && !r.viewer.can_approve && (
            <>
              <p className="muted">{t("learn.forwardHelp")}</p>
              <PersonPicker projectId={r.project_id} reviewId={r.id} purpose="forward" chosen={target} onChoose={setTarget} />
              <button type="button" className="btn btn-primary" disabled={busy || !target} onClick={() => target && void decide({ kind: "forward", to: target.id })}>
                {target ? t("learn.forwardTo", { name: target.name }) : t("learn.forward")}
              </button>
            </>
          )}
          {oversee && (
            <details className="learning-recovery" open={!!r.reviewer && !r.reviewer.available}>
              <summary>{t("learn.reassignHelp")}</summary>
              <PersonPicker projectId={r.project_id} reviewId={r.id} purpose="reassign" chosen={target} onChoose={setTarget} />
              <label htmlFor={reasonId}>{t("learn.reassignReason")}</label>
              <textarea id={reasonId} rows={2} maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button type="button" className="btn" disabled={busy || !target || !reason.trim()}
                onClick={() => target && void run(() => reassignLearningReview(actorId, r.id, action.current, r.revision, target.id, reason))}>
                {t("learn.reassign", { name: target?.name ?? "…" })}
              </button>
            </details>
          )}
        </div>
      )}
      {r.viewer.can_withdraw && (
        <details className="learning-withdraw">
          <summary>{t("learn.withdraw")}</summary>
          <p className="muted">{t("learn.withdrawNote")}</p>
          <label htmlFor={reasonId}>{t("learn.withdrawReason")}</label>
          <textarea id={reasonId} rows={2} maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn" disabled={busy || !reason.trim()} onClick={() => void withdraw()}>{t("learn.withdraw")}</button>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>{t("learn.history")}</summary>
        <ol className="learning-history">
          {r.history.map((e) => (
            <li key={e.revision}>
              <span className="muted">{when(e.at)} · </span>
              {t(`learn.event.${e.action}` as LearningKey, { actor: e.actor?.name ?? "—", reviewer: e.reviewer?.name ?? "—", revision: e.revision })}
              {e.oversight ? ` (${t("learn.event.oversight")})` : ""}
              {e.note && <p className="learning-note">{e.note}</p>}
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}
