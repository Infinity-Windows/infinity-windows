// The Forge AI daily log card: the draft, the shared log it joins, the photos
// and where each one goes, the one Save button, and the real receipt.
//
// Everything that writes is a tap on this card. Forge AI's replies only fill
// answers (controller.applyModelReply); the job, every photo's destination and
// Save belong to the person holding the phone.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Camera, CheckCircle2, ImagePlus, Mic, RefreshCw, Trash2 } from "lucide-react";
import { listProjects } from "../../lib/api";
import { usePhotoPicker } from "../../lib/photo/usePhotoPicker";
import { formatLogDateLabel, localDateISO } from "../../lib/dailyLogDay";
import {
  CORE_FIELDS,
  OPTIONAL_FIELDS,
  DAY_FLOWS,
  type DailyLogField,
} from "../../../../supabase/functions/_shared/aiDailyLog";
import {
  MAX_DRAFT_PHOTOS,
  isFrozen,
  previewAddition,
  saveProblems,
  type DailyLogJobRef,
  type SaveProblem,
} from "../../lib/aiDailyLogs/draft";
import type { AiDailyLogController, PhotoView } from "../../lib/aiDailyLogs/useAiDailyLogDraft";
import { useAiLogT, type TKey, type TFn } from "./dailyLogCatalog";
import "./aiDailyLogs.css";

export type DailyLogSuggestions = Partial<Record<DailyLogField, { value: string; source: "job_clock" | "unit_records" | "earlier_log" }>>;

export interface AiDailyLogCardProps {
  controller: AiDailyLogController;
  /** Jobs the person may pick from. Defaults to the active jobs list. */
  jobs?: DailyLogJobRef[];
  /** Known context, each with its source. Shown only for unanswered fields,
   * and used only when the person taps "Use this". */
  suggestions?: DailyLogSuggestions;
  /** The host's existing voice composer (Ask's microphone). */
  onAnswerByVoice?: () => void;
}

const jobLabel = (p: { job_code?: string | null; name?: string | null }) =>
  [p.job_code, p.name].filter(Boolean).join(" · ");

function JobPicker({ jobs, onPick, t }: { jobs: DailyLogJobRef[]; onPick: (j: DailyLogJobRef) => void; t: TFn }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (needle ? jobs.filter((j) => j.label.toLowerCase().includes(needle)) : jobs).slice(0, 8);
  }, [jobs, q]);
  return (
    <div className="ai-log-picker">
      <label className="daily-log-field">
        <span>{t("aiLog.searchJobs")}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("aiLog.searchJobs")} />
      </label>
      <div className="ai-log-options">
        {shown.map((j) => <button type="button" key={j.projectId} onClick={() => onPick(j)}>{j.label}</button>)}
      </div>
    </div>
  );
}

function PhotoThumb({ controller, view, jobLabelText, t }: { controller: AiDailyLogController; view: PhotoView; jobLabelText: string | null; t: TFn }) {
  const { photo, state, error } = view;
  const [url, setUrl] = useState<string | null>(null);
  const getBlob = controller.photoBlob;
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    void getBlob(photo.id).then((blob) => {
      if (!alive || !blob) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [getBlob, photo.id]);
  const draft = controller.draft!;
  const frozen = isFrozen(draft);
  const job = draft.job;
  const otherJob = Boolean(job && photo.destination && photo.destination.projectId !== job.projectId);
  return (
    <li className={`ai-log-photo ai-log-photo-${state}`} data-photo-id={photo.id}>
      {url ? <img src={url} alt="" /> : <div className="ai-log-photo-placeholder" aria-hidden="true"><ImagePlus size={20} /></div>}
      <div className="ai-log-photo-body">
        <p className="ai-log-photo-dest">
          {photo.destination ? t("aiLog.photoDestination", { job: photo.destination.label }) : t("aiLog.photoNoJob")}
        </p>
        {otherJob && !frozen && <p className="ai-log-warn">{t("aiLog.photoOtherJob", { job: photo.destination!.label })}</p>}
        {(draft.receipt || photo.queuedAt) && (
          <p className={`ai-log-photo-status ai-log-status-${state}`} role="status">{t(`aiLog.photo.${state}` as TKey)}{error ? ` — ${error}` : ""}</p>
        )}
        {!draft.receipt && !frozen && <p className="muted ai-log-photo-status">{t("aiLog.photo.on_phone")}</p>}
        {!frozen && (
          <label className="daily-log-field">
            <span>{t("aiLog.caption")}</span>
            <input defaultValue={photo.caption ?? ""} onBlur={(e) => controller.setCaption(photo.id, e.target.value)} aria-label={t("aiLog.caption")} />
          </label>
        )}
        <div className="ai-log-options">
          {!frozen && job && (otherJob || !photo.destination) && (
            <button type="button" onClick={() => controller.movePhoto(photo.id, { projectId: job.projectId, label: job.label })}>
              {t("aiLog.moveHere", { job: job.label })}
            </button>
          )}
          {!frozen && (
            <button type="button" onClick={() => controller.removePhoto(photo.id)} aria-label={`${t("aiLog.remove")} ${jobLabelText ?? ""}`.trim()}>
              <Trash2 size={16} aria-hidden="true" /> {t("aiLog.remove")}
            </button>
          )}
          {/* A saved entry's photo that has not reached the server: the queue
              gave up (failed), the queue never took it (on_phone), or the queue
              no longer has it and the server never got it (checking). Each is
              retried under the same photo id, from the bytes this draft kept. */}
          {draft.receipt && (state === "failed" || state === "on_phone") && (
            <button type="button" onClick={() => void controller.retryPhoto(photo.id)}><RefreshCw size={16} aria-hidden="true" /> {t("aiLog.retryPhoto")}</button>
          )}
          {draft.receipt && state === "checking" && (
            <button type="button" onClick={() => void controller.retryPhoto(photo.id)}><RefreshCw size={16} aria-hidden="true" /> {t("aiLog.sendAgain")}</button>
          )}
        </div>
      </div>
    </li>
  );
}

function problemText(t: TFn, p: SaveProblem): string | null {
  switch (p.kind) {
    case "no_work": return t("aiLog.problem.no_work");
    case "no_job": return t("aiLog.problem.no_job");
    case "choose_between": return t("aiLog.chooseBetween");
    case "log_not_checked": return t("aiLog.problem.log_not_checked");
    case "photo_without_job": return t("aiLog.problem.photo_without_job");
    case "photo_other_job": return t("aiLog.photoOtherJob", { job: p.destination.label });
    case "bad_date": return t("aiLog.problem.bad_date");
    case "too_long": return t("aiLog.problem.too_long", { length: p.length, max: p.max });
  }
}

export function AiDailyLogCard({ controller, jobs, suggestions = {}, onAnswerByVoice }: AiDailyLogCardProps) {
  const t = useAiLogT();
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects, enabled: !jobs });
  const jobList = useMemo<DailyLogJobRef[]>(
    () => jobs ?? (projects.data ?? []).map((p) => ({ projectId: p.id, label: jobLabel(p) })),
    [jobs, projects.data],
  );
  const [picking, setPicking] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [unsentBlock, setUnsentBlock] = useState(0);
  const picker = usePhotoPicker({ camera: true, multiple: true, onFiles: (files) => controller.attachFiles(files) });

  const { draft, actor } = controller;
  if (!actor) return <section className="field-card ai-log-card"><p>{t("aiLog.signIn")}</p></section>;
  if (controller.loading || !draft) return <section className="field-card ai-log-card"><p className="muted">{t("aiLog.loading")}</p></section>;

  const frozen = isFrozen(draft);
  const today = localDateISO();
  const problems = saveProblems(draft, today);
  const preparing = controller.preparingPhotos;
  const startAnother = async (discardUnsent = false) => {
    const result = await controller.startOver({ discardUnsent });
    setUnsentBlock(!result.done && result.reason === "unsent_photos" ? result.unsent : 0);
  };
  const r = draft.receipt;
  const addition = previewAddition(draft, actor.displayName);
  const fieldRow = (key: DailyLogField) => {
    const a = draft.answers[key];
    const status = a ? a.status : "missing";
    const suggestion = suggestions[key];
    return (
      <div className={`ai-log-row ai-log-${status}`} key={key}>
        <div className="ai-log-row-head">
          <span className="ai-log-label">{t(`aiLog.field.${key}` as TKey)}{key === "work_completed" ? ` · ${t("aiLog.required")}` : ""}</span>
          <span className="ai-log-chip">{t(`aiLog.status.${status}` as TKey)}{a ? ` · ${t(`aiLog.source.${a.source}` as TKey)}` : ""}</span>
        </div>
        {key === "day_flow" ? (
          <div className="grade-row" role="group" aria-label={t("aiLog.field.day_flow")}>
            {DAY_FLOWS.map((f) => (
              <button key={f} type="button" disabled={frozen} aria-pressed={a?.status === "captured" && a.value === f}
                className={a?.status === "captured" && a.value === f ? "grade-btn selected" : "grade-btn"}
                onClick={() => controller.editAnswer("day_flow", a?.status === "captured" && a.value === f ? null : f)}>
                {t(`aiLog.flow.${f}` as TKey)}
              </button>
            ))}
          </div>
        ) : (
          <textarea
            rows={key === "work_completed" ? 3 : 2}
            aria-label={t(`aiLog.field.${key}` as TKey)}
            disabled={frozen}
            value={a?.status === "captured" ? a.value : ""}
            placeholder={a?.status === "unknown" ? t("aiLog.status.unknown") : ""}
            onChange={(e) => controller.editAnswer(key, e.target.value)}
          />
        )}
        {!frozen && (
          <div className="ai-log-options">
            {status !== "unknown" && <button type="button" onClick={() => controller.editAnswer(key, { unknown: true })}>{t("aiLog.markUnknown")}</button>}
            {status !== "missing" && <button type="button" onClick={() => controller.editAnswer(key, null)}>{t("aiLog.clear")}</button>}
            {status === "missing" && suggestion && (
              <button type="button" onClick={() => controller.acceptSuggestion(key, suggestion.value, suggestion.source)}>
                {t("aiLog.useSuggestion")}: {suggestion.value} ({t(`aiLog.source.${suggestion.source}` as TKey)})
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="field-card ai-log-card" aria-label={t("aiLog.title")}>
      <header className="ai-log-header">
        <h3>{t("aiLog.title")}</h3>
        <p className="ai-log-job"><span className="muted">{t("aiLog.job")}:</span> <strong>{draft.job?.label ?? "—"}</strong></p>
        <p className="ai-log-date"><span className="muted">{t("aiLog.date")}:</span> <strong>{formatLogDateLabel(draft.logDate)}</strong></p>
        {!frozen && (
          <label className="daily-log-field ai-log-date-field">
            <span>{t("aiLog.workDate")}</span>
            {/* A late entry is normal (a day with no signal); a future one is not. */}
            <input type="date" max={today} value={draft.logDate} aria-label={t("aiLog.workDate")}
              onChange={(e) => { if (e.target.value) controller.setLogDate(e.target.value); }} />
          </label>
        )}
      </header>

      {!controller.durable && <p className="ai-log-warn">{t("aiLog.notDurable")}</p>}
      {controller.storageError && (
        <div className="ai-log-warn" role="alert">
          <p>{t("aiLog.storageError")}</p>
          <button type="button" onClick={() => void controller.retryStorage()}>{t("aiLog.retryStorage")}</button>
        </div>
      )}
      {controller.blockedByAccount && <p className="ai-log-warn" role="alert">{t("aiLog.blockedByAccount")}</p>}

      {r && (
        <div className="ai-log-receipt" role="status">
          <p className="ok"><CheckCircle2 size={18} aria-hidden="true" /> {t("aiLog.receipt.saved", { job: draft.job?.label ?? "", date: formatLogDateLabel(r.log_date) })}</p>
          {r.status === "already_saved" && <p>{t("aiLog.receipt.already")}</p>}
          <p>{r.created_log ? t("aiLog.receipt.started") : t("aiLog.receipt.added", { name: r.log?.filed_by_name ?? "—" })}</p>
          <p className="muted">{t("aiLog.receipt.when", {
            time: new Date(r.saved_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
            name: r.actor_name ?? "—",
            id: r.contribution_id.slice(0, 8),
          })}</p>
          <div className="ai-log-options">
            <Link className="action-btn" to={`/projects/${r.project_id}?tab=logs`}>{t("aiLog.openLog")}</Link>
            <button type="button" onClick={() => void startAnother()}>{t("aiLog.startOver")}</button>
          </div>
          {unsentBlock > 0 && (
            <div className="ai-log-warn" role="alert">
              <p>{t("aiLog.unsentBlocked", { n: unsentBlock })}</p>
              {/* The one way past it, and it says exactly what it loses. */}
              <button type="button" className="ai-log-discard" onClick={() => {
                if (window.confirm(t("aiLog.discardUnsentConfirm", { n: unsentBlock }))) void startAnother(true);
              }}>{t("aiLog.discardUnsent", { n: unsentBlock })}</button>
            </div>
          )}
        </div>
      )}

      {!frozen && (
        <div className="ai-log-jobs">
          {!draft.job && <p><strong>{draft.candidates.length > 1 ? t("aiLog.chooseBetween") : t("aiLog.noJob")}</strong></p>}
          {draft.job && draft.candidates.length > 0 && <p className="ai-log-warn">{t("aiLog.chatNamed")}</p>}
          <div className="ai-log-options">
            {draft.candidates.map((c) => (
              <button type="button" key={c.projectId} className="primary" onClick={() => controller.chooseJob(c, "chat")}>{t("aiLog.useJob", { job: c.label })}</button>
            ))}
            <button type="button" onClick={() => setPicking((v) => !v)}>{draft.job ? t("aiLog.changeJob") : t("aiLog.pickJob")}</button>
          </div>
          {picking && <JobPicker jobs={jobList} t={t} onPick={(j) => { controller.chooseJob(j, "picked"); setPicking(false); }} />}
        </div>
      )}

      {!r && <p className="muted">{t("aiLog.shared")}</p>}
      {!r && !frozen && (
        <div className="ai-log-answer-help">
          <p className="muted">{t("aiLog.answerHelp")}</p>
          {onAnswerByVoice && <button type="button" onClick={onAnswerByVoice}><Mic size={16} aria-hidden="true" /> {t("aiLog.answerByVoice")}</button>}
        </div>
      )}

      {!r && <div className="ai-log-fields">{CORE_FIELDS.map(fieldRow)}</div>}
      {!r && (
        <div className="ai-log-more">
          <button type="button" aria-expanded={showMore || OPTIONAL_FIELDS.some((k) => draft.answers[k])} onClick={() => setShowMore((v) => !v)}>{t("aiLog.moreDetails")}</button>
          {(showMore || OPTIONAL_FIELDS.some((k) => draft.answers[k])) && <div className="ai-log-fields">{OPTIONAL_FIELDS.map(fieldRow)}</div>}
        </div>
      )}

      {!r && draft.job && (
        <div className="ai-log-existing">
          <h4>{t("aiLog.existing")}</h4>
          {controller.checkingLog && <p className="muted">{t("aiLog.checkingLog")}</p>}
          {controller.logError && <p className="ai-log-warn">{t("aiLog.logLoadFailed")} <button type="button" onClick={() => void controller.refreshLog()}>{t("aiLog.checkAgain")}</button></p>}
          {draft.base && !draft.base.log && <p className="muted">{t("aiLog.noExisting")}</p>}
          {draft.base?.log && <>
            {draft.base.log.filed_by_name && <p className="muted">{t("aiLog.existingBy", { name: draft.base.log.filed_by_name })}</p>}
            <pre className="ai-log-text">{draft.base.log.notes}</pre>
          </>}
        </div>
      )}

      <div className="ai-log-photos">
        <h4>{t("aiLog.photos")}</h4>
        {!frozen && <>
          <p className="muted">{t("aiLog.photoHint")} {t("aiLog.photoLimit", { n: MAX_DRAFT_PHOTOS })}</p>
          <div className="ai-log-options">
            <button type="button" onClick={picker.openCamera} disabled={draft.photos.length >= MAX_DRAFT_PHOTOS}><Camera size={16} aria-hidden="true" /> {t("aiLog.takePhoto")}</button>
            <button type="button" onClick={picker.openLibrary} disabled={draft.photos.length >= MAX_DRAFT_PHOTOS}><ImagePlus size={16} aria-hidden="true" /> {t("aiLog.choosePhotos")}</button>
          </div>
          {picker.inputs}
        </>}
        {preparing > 0 && <p className="muted" role="status">{t("aiLog.preparing", { n: preparing })}</p>}
        {controller.rejectedPhotos.map((x, i) => <p key={`${x.name}-${i}`} className="ai-log-warn" role="alert">{t(`aiLog.reject.${x.reason}` as TKey, { name: x.name })}</p>)}
        {r && draft.photos.length > 0 && <p className="muted">{t("aiLog.receipt.photosSeparate")}</p>}
        <ul className="ai-log-photo-list">
          {controller.photoViews.map((v) => <PhotoThumb key={v.photo.id} controller={controller} view={v} jobLabelText={v.photo.destination?.label ?? null} t={t} />)}
        </ul>
        {controller.queueFailures.map((f) => <p key={f.photoId} className="ai-log-warn" role="alert">{f.message}</p>)}
      </div>

      {!r && (
        <div className="ai-log-preview">
          <h4>{t("aiLog.addition")}</h4>
          <pre className="ai-log-text">{addition}</pre>
        </div>
      )}

      {draft.notice?.kind === "stale" && <p className="ai-log-warn" role="alert">{t("aiLog.notice.stale")}</p>}
      {draft.notice?.kind === "uncertain" && <p className="ai-log-warn" role="alert">{t("aiLog.notice.uncertain")}</p>}
      {draft.notice?.kind === "source_limit" && (
        <div className="ai-log-warn" role="alert">
          <p>{t("aiLog.notice.source_limit")}</p>
          <button type="button" onClick={() => controller.keepHeldAsTyped()}>{t("aiLog.keepHeld")}</button>
        </div>
      )}
      {draft.notice?.kind === "rejected" && <p className="ai-log-warn" role="alert">{t("aiLog.notice.rejected", { message: draft.notice.message })}</p>}
      {draft.pending && !controller.saving && <p className="muted">{t("aiLog.frozen")}</p>}

      {!r && (
        <footer className="ai-log-footer">
          {preparing > 0 && !draft.pending && <p className="muted">{t("aiLog.preparing", { n: preparing })}</p>}
          {!draft.pending && problems.length > 0 && (
            <ul className="ai-log-problems">
              {problems.map((p, i) => { const text = problemText(t, p); return text ? <li key={i}>{text}</li> : null; })}
            </ul>
          )}
          <button type="button" className="primary big" disabled={controller.saving || preparing > 0 || (!draft.pending && problems.length > 0)} onClick={() => void controller.save()}>
            {controller.saving ? t("aiLog.saving") : draft.pending ? t("aiLog.tryAgain") : t("aiLog.save")}
          </button>
          {!draft.pending && (
            <button type="button" className="ai-log-discard" onClick={() => { if (window.confirm(t("aiLog.discardConfirm"))) void controller.startOver(); }}>{t("aiLog.discardDraft")}</button>
          )}
        </footer>
      )}

    </section>
  );
}
