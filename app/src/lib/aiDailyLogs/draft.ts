// The Forge AI daily log draft on the phone: one job, one day, one person's
// contribution to the shared log, plus the photos they attached to it.
//
// Pure. Every rule that decides WHERE something is saved lives here and is
// unit-tested (draft.test.ts); the hook and the card only call it.
//
//  * The job is the one the person tapped. Chat can offer candidates; it cannot
//    pick one, and a later chat job never moves anything already attached.
//  * A photo's destination is fixed when it is attached (the confirmed job, or
//    none — "choose a job"). Only the person moves or removes it.
//  * The model only ever fills answers (applyModelAnswers). A reply for another
//    draft or another account is ignored.
//  * A photo's job is the one showing when the person picked it, passed in by
//    the caller — never read again after decoding, so a job change while it
//    is being prepared cannot reroute it.
//  * Typed words are kept exactly as typed (spaces, line breaks); they are
//    trimmed only when serialised for the server.
//  * The saved entry names the account (actorId) and every Ask message its
//    answers came from (sourceRequestIds). The server checks both.
//  * Once Save is pressed the exact payload is frozen. Every retry resends those
//    bytes under the same id until the server answers for certain, so a lost
//    response can never become a second entry, and nothing edited after the
//    press can ride along on the retry.
import {
  answersForServer,
  composeDailyLogBody,
  contributionHeader,
  DAILY_LOG_FIELDS,
  hasWords,
  mergeDailyLogAnswers,
  answersFromToolInput,
  MAX_BODY_CHARS,
  type DailyLogAnswers,
  type DailyLogField,
} from "../../../../supabase/functions/_shared/aiDailyLog";

export const MAX_DRAFT_PHOTOS = 12;
/** The server's own cap on source_request_ids (_daily_log_sources). */
export const MAX_SOURCE_REQUESTS = 50;

export interface DailyLogJobRef {
  projectId: string;
  /** "SMITH · Smith Residence" — what the person sees and chose. */
  label: string;
}
export interface DraftJob extends DailyLogJobRef {
  /** How it was chosen. Every source still needs the person's tap. */
  source: "picked" | "chat" | "job_clock";
}

export interface DraftPhoto {
  /** Minted when the photo is taken. Becomes the outbox entry id and
   * attachments.client_id, so every retry is the same photo. */
  id: string;
  destination: DailyLogJobRef | null;
  caption: string | null;
  takenAt: string;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  bytes: number;
  /** When it was handed to the upload queue: only after the log saved, and
   * only to the saved log's job. Null means the bytes are still only here. */
  queuedAt: string | null;
}

/** What the shared log said when the person looked (0 = no log yet). */
export interface ExistingLogSnapshot {
  id: string;
  revision: number;
  notes: string;
  headline: string | null;
  day_flow: string | null;
  weather: string | null;
  reflection: Record<string, string> | null;
  filed_by: string;
  filed_by_name: string | null;
  updated_at: string | null;
}
export interface DraftBase { revision: number; log: ExistingLogSnapshot | null; checkedAt: string }

export interface SavePayload {
  id: string;
  /** The account that pressed Save. The server refuses it for anyone else. */
  actorId: string;
  projectId: string;
  logDate: string;
  expectedRevision: number;
  answers: ReturnType<typeof answersForServer>;
  body: string;
  photoIds: string[];
  /** Every Ask message whose answers are in this entry, in order. */
  sourceRequestIds: string[];
}

export interface ContributionReceipt {
  status: "saved" | "already_saved";
  contribution_id: string;
  log_id: string;
  project_id: string;
  log_date: string;
  actor_id: string;
  actor_name: string | null;
  base_revision: number;
  saved_revision: number;
  created_log: boolean;
  saved_at: string;
  photo_ids: string[];
  source_request_ids?: string[];
  log: ExistingLogSnapshot | null;
}

export interface AiDailyLogDraft {
  version: 1;
  /** The contribution id: the server's idempotency key. */
  id: string;
  /** The account that owns this draft, its photos and every retry. */
  userId: string;
  logDate: string;
  job: DraftJob | null;
  /** Jobs the chat named that the person has not chosen between. */
  candidates: DailyLogJobRef[];
  answers: DailyLogAnswers;
  /** Fields the person typed or edited: the model never changes these. */
  locked: DailyLogField[];
  photos: DraftPhoto[];
  /** The Ask conversation this draft is being built in, and every message of
   * it that contributed answers. A reply from another conversation adds none. */
  sources: { conversationId: string | null; requestIds: string[] };
  base: DraftBase | null;
  /** Sent and not yet answered for certain. Resent unchanged. */
  pending: { payload: SavePayload; firstSentAt: string; attempts: number } | null;
  receipt: ContributionReceipt | null;
  /** The last honest sentence about a save that did not complete. */
  notice: SaveNotice | null;
  updatedAt: string;
}

export type SaveNotice =
  | { kind: "stale"; revision: number }
  | { kind: "uncertain" }
  | { kind: "rejected"; message: string }
  /** A new Ask message would take the entry past MAX_SOURCE_REQUESTS. Its words
   * are held here, unapplied, until the person keeps them as their own. */
  | { kind: "source_limit"; held: DailyLogAnswers };

export function newDraft(userId: string, logDate: string, id: string = crypto.randomUUID(), now = new Date()): AiDailyLogDraft {
  return {
    version: 1, id, userId, logDate, job: null, candidates: [], answers: {}, locked: [], photos: [],
    sources: { conversationId: null, requestIds: [] },
    base: null, pending: null, receipt: null, notice: null, updatedAt: now.toISOString(),
  };
}

/** Nothing about where or what changes once Save was pressed. */
export function isFrozen(d: AiDailyLogDraft): boolean {
  return d.pending !== null || d.receipt !== null;
}
const touch = (d: AiDailyLogDraft, patch: Partial<AiDailyLogDraft>): AiDailyLogDraft => ({ ...d, ...patch, updatedAt: new Date().toISOString() });

/**
 * The person tapped a job. The existing-log preview is for the old job, so it
 * is cleared and must be read again before Save. Photos keep their own
 * destinations; any that now differ are flagged by saveProblems, never moved.
 */
export function chooseJob(d: AiDailyLogDraft, job: DailyLogJobRef, source: DraftJob["source"] = "picked"): AiDailyLogDraft {
  if (isFrozen(d)) return d;
  if (d.job?.projectId === job.projectId) return touch(d, { job: { ...job, source }, candidates: [] });
  return touch(d, { job: { ...job, source }, candidates: [], base: null, notice: null });
}

/** The chat named jobs. They are offered, never chosen. */
export function offerJobs(d: AiDailyLogDraft, candidates: DailyLogJobRef[]): AiDailyLogDraft {
  if (isFrozen(d)) return d;
  const unique = candidates.filter((c, i) => candidates.findIndex((x) => x.projectId === c.projectId) === i);
  return touch(d, { candidates: unique.filter((c) => c.projectId !== d.job?.projectId).slice(0, 8) });
}

/** A real calendar day, written YYYY-MM-DD, not after `today`. */
export function validLogDate(logDate: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(logDate)) return false;
  const [y, m, day] = logDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) return false;
  return logDate <= today;
}

/** The person changed the work date. The preview was for the old day, so the
 * shared log is read again before Save (base cleared). */
export function setLogDate(d: AiDailyLogDraft, logDate: string, today: string): AiDailyLogDraft {
  if (isFrozen(d) || d.logDate === logDate || !validLogDate(logDate, today)) return d;
  return touch(d, { logDate, base: null, notice: null });
}

/**
 * A model reply. Applied only to the draft and account it was asked for, and
 * only before Save; anything but answers in it is ignored.
 */
export interface ModelReply {
  draftId: string;
  userId: string;
  toolInput: unknown;
  /** The saved Ask message (ai_field_requests id) this answer came from.
   * Required: a model answer with no evidence behind it is not applied. */
  requestId: string;
  conversationId: string;
}
/**
 * A model reply. Applied only to this draft, account and conversation, only
 * before Save, and only with the Ask message it came from — that id becomes
 * the entry's evidence, so an answer without one is not taken. Past
 * MAX_SOURCE_REQUESTS a NEW message is not applied either (its evidence could
 * not be kept); its words are held in the notice for the person to keep as
 * typed text. The same message may still send more tool input.
 */
export function applyModelAnswers(d: AiDailyLogDraft, reply: ModelReply): AiDailyLogDraft {
  if (reply.draftId !== d.id || reply.userId !== d.userId || isFrozen(d)) return d;
  if (!reply.requestId || !reply.conversationId) return d;
  const sources = d.sources ?? { conversationId: null, requestIds: [] };
  // One conversation per entry: a late reply from another one changes nothing.
  if (sources.conversationId && reply.conversationId !== sources.conversationId) return d;
  const patch = answersFromToolInput(reply.toolInput);
  if (!Object.keys(patch).length) return d;
  const known = sources.requestIds.includes(reply.requestId);
  if (!known && sources.requestIds.length >= MAX_SOURCE_REQUESTS) {
    const held = d.notice?.kind === "source_limit" ? { ...d.notice.held, ...patch } : patch;
    return touch(d, { notice: { kind: "source_limit", held } });
  }
  const answers = mergeDailyLogAnswers(d.answers, patch, new Set(d.locked));
  const requestIds = known ? sources.requestIds : [...sources.requestIds, reply.requestId];
  return touch(d, { answers, sources: { conversationId: sources.conversationId ?? reply.conversationId, requestIds } });
}

/** The person keeps held words (source_limit) as their own typed answers. */
export function keepHeldAsTyped(d: AiDailyLogDraft): AiDailyLogDraft {
  if (isFrozen(d) || d.notice?.kind !== "source_limit") return d;
  let next = touch(d, { notice: null });
  for (const key of DAILY_LOG_FIELDS) {
    const a = d.notice.held[key];
    if (a) next = editAnswer(next, key, a.status === "captured" ? a.value : { unknown: true });
  }
  return next;
}

/** The person typed an answer, said unknown, or cleared it (missing). Locked. */
export function editAnswer(d: AiDailyLogDraft, key: DailyLogField, value: string | { unknown: true } | null): AiDailyLogDraft {
  if (isFrozen(d)) return d;
  const answers = { ...d.answers };
  // Kept exactly as typed: trimming each keystroke would eat the space before
  // the next word. Serialisation (answersForServer) trims.
  if (value === null || (typeof value === "string" && !value.trim())) delete answers[key];
  else if (typeof value === "string") answers[key] = { status: "captured", value, source: "typed" };
  else answers[key] = { status: "unknown", source: "typed" };
  return touch(d, { answers, locked: d.locked.includes(key) ? d.locked : [...d.locked, key] });
}

/** Known context (job clock, unit records) kept by the person's tap. */
export function acceptSuggestion(d: AiDailyLogDraft, key: DailyLogField, value: string, source: "job_clock" | "unit_records" | "earlier_log"): AiDailyLogDraft {
  if (isFrozen(d) || !value.trim()) return d;
  return touch(d, {
    answers: { ...d.answers, [key]: { status: "captured", value: value.trim(), source } },
    locked: d.locked.includes(key) ? d.locked : [...d.locked, key],
  });
}

/** The job showing when a photo is picked — the caller reads this BEFORE any
 * decoding, and hands it to addPhoto unchanged. */
export function destinationNow(d: AiDailyLogDraft): DailyLogJobRef | null {
  return d.job ? { projectId: d.job.projectId, label: d.job.label } : null;
}

/** A prepared photo, going where it was pointed when picked (or nowhere). If
 * the job changed since, saveProblems asks the person to move or remove it. */
export function addPhoto(d: AiDailyLogDraft, photo: Omit<DraftPhoto, "destination" | "queuedAt">, destination: DailyLogJobRef | null): AiDailyLogDraft {
  if (isFrozen(d) || d.photos.length >= MAX_DRAFT_PHOTOS || d.photos.some((p) => p.id === photo.id)) return d;
  return touch(d, { photos: [...d.photos, { ...photo, destination: destination ? { ...destination } : null, queuedAt: null }] });
}

export function removePhoto(d: AiDailyLogDraft, photoId: string): AiDailyLogDraft {
  if (isFrozen(d)) return d;
  return touch(d, { photos: d.photos.filter((p) => p.id !== photoId) });
}

/** Only the person moves a photo, and only before Save. */
export function setPhotoDestination(d: AiDailyLogDraft, photoId: string, job: DailyLogJobRef): AiDailyLogDraft {
  if (isFrozen(d)) return d;
  return touch(d, { photos: d.photos.map((p) => (p.id === photoId ? { ...p, destination: { ...job } } : p)) });
}

export function setCaption(d: AiDailyLogDraft, photoId: string, caption: string): AiDailyLogDraft {
  if (isFrozen(d)) return d;
  return touch(d, { photos: d.photos.map((p) => (p.id === photoId ? { ...p, caption: caption.trim() ? caption.slice(0, 500) : null } : p)) });
}

/** The shared log as it is now (null = nobody has filed it yet). */
export function setBase(d: AiDailyLogDraft, log: ExistingLogSnapshot | null, now = new Date()): AiDailyLogDraft {
  if (d.pending) return d;
  return touch(d, { base: { revision: log?.revision ?? 0, log, checkedAt: now.toISOString() } });
}

export type SaveProblem =
  | { kind: "no_job" }
  | { kind: "choose_between"; candidates: DailyLogJobRef[] }
  | { kind: "no_work" }
  | { kind: "bad_date" }
  | { kind: "too_long"; length: number; max: number }
  | { kind: "log_not_checked" }
  | { kind: "photo_without_job"; photoId: string }
  | { kind: "photo_other_job"; photoId: string; destination: DailyLogJobRef };

/** Everything that stops Save, in the order the card shows it. */
export function saveProblems(d: AiDailyLogDraft, today: string): SaveProblem[] {
  if (d.pending) return [];
  const problems: SaveProblem[] = [];
  if (!d.job) problems.push(d.candidates.length > 1 ? { kind: "choose_between", candidates: d.candidates } : { kind: "no_job" });
  if (!hasWords(d.answers.work_completed)) problems.push({ kind: "no_work" });
  if (!validLogDate(d.logDate, today)) problems.push({ kind: "bad_date" });
  // Never cut: the shared log gets all of it or none of it.
  const length = previewBody(d).length;
  if (length > MAX_BODY_CHARS) problems.push({ kind: "too_long", length, max: MAX_BODY_CHARS });
  if (d.job && !d.base) problems.push({ kind: "log_not_checked" });
  for (const p of d.photos) {
    if (!p.destination) problems.push({ kind: "photo_without_job", photoId: p.id });
    else if (d.job && p.destination.projectId !== d.job.projectId) problems.push({ kind: "photo_other_job", photoId: p.id, destination: p.destination });
  }
  return problems;
}

/** What the person sees above Save, and what the server will append. */
export function previewBody(d: AiDailyLogDraft): string {
  return composeDailyLogBody(d.answers, d.photos.length);
}
export function previewAddition(d: AiDailyLogDraft, displayName: string | null): string {
  return `${contributionHeader(displayName)}\n${previewBody(d)}`;
}

/**
 * Press Save. Returns the payload to send and the draft to persist BEFORE
 * sending. A draft already waiting on an answer resends its frozen payload.
 */
export function beginSave(d: AiDailyLogDraft, today: string, now = new Date()): { draft: AiDailyLogDraft; payload: SavePayload } | { problems: SaveProblem[] } {
  if (d.receipt) return { problems: [] };
  if (d.pending) {
    return { payload: d.pending.payload, draft: touch(d, { pending: { ...d.pending, attempts: d.pending.attempts + 1 }, notice: null }) };
  }
  const problems = saveProblems(d, today);
  if (problems.length || !d.job || !d.base) return { problems };
  const payload: SavePayload = {
    id: d.id,
    actorId: d.userId,
    projectId: d.job.projectId,
    logDate: d.logDate,
    expectedRevision: d.base.revision,
    answers: answersForServer(d.answers),
    body: previewBody(d),
    photoIds: d.photos.map((p) => p.id),
    sourceRequestIds: [...(d.sources?.requestIds ?? [])],
  };
  return { payload, draft: touch(d, { pending: { payload, firstSentAt: now.toISOString(), attempts: 1 }, notice: null }) };
}

export type SaveOutcome =
  | { kind: "receipt"; receipt: ContributionReceipt }
  | { kind: "stale"; current: ExistingLogSnapshot | null; revision: number }
  /** The server answered no (validation, permission). Nothing was saved. */
  | { kind: "rejected"; message: string }
  /** No answer, or no way to tell: it may or may not have saved. */
  | { kind: "uncertain" };

export function applySaveOutcome(d: AiDailyLogDraft, payloadId: string, outcome: SaveOutcome, now = new Date()): AiDailyLogDraft {
  if (payloadId !== d.id) return d;
  switch (outcome.kind) {
    case "receipt":
      return touch(d, { receipt: outcome.receipt, pending: null, notice: null, candidates: [] });
    case "stale":
      // Nothing was written. Show the log as it is now; the person saves again.
      return touch(d, {
        pending: null,
        base: { revision: outcome.revision, log: outcome.current, checkedAt: now.toISOString() },
        notice: { kind: "stale", revision: outcome.revision },
      });
    case "rejected":
      return touch(d, { pending: null, notice: { kind: "rejected", message: outcome.message } });
    case "uncertain":
      return touch(d, { notice: { kind: "uncertain" } });
  }
}

/** Photos the saved log owns and the upload queue does not have yet. */
export function photosReadyToQueue(d: AiDailyLogDraft): DraftPhoto[] {
  const r = d.receipt;
  if (!r) return [];
  return d.photos.filter((p) => !p.queuedAt && p.destination?.projectId === r.project_id && r.photo_ids.includes(p.id));
}
/** The queue no longer has a handed-over photo and the server never got it
 * (e.g. discarded from Stuck writes). Its bytes are still in this draft, so it
 * can be handed over again — under the same id. */
export function unmarkQueued(d: AiDailyLogDraft, photoId: string): AiDailyLogDraft {
  return touch(d, { photos: d.photos.map((p) => (p.id === photoId ? { ...p, queuedAt: null } : p)) });
}
export function markQueued(d: AiDailyLogDraft, photoId: string, now = new Date()): AiDailyLogDraft {
  return touch(d, { photos: d.photos.map((p) => (p.id === photoId && !p.queuedAt ? { ...p, queuedAt: now.toISOString() } : p)) });
}

/** Keys the checklist shows, in order. */
export const FIELD_ORDER: readonly DailyLogField[] = DAILY_LOG_FIELDS;

/** A stored draft, checked: anything unreadable or someone else's is dropped. */
export function readDraft(raw: unknown, userId: string): AiDailyLogDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<AiDailyLogDraft>;
  if (d.version !== 1 || typeof d.id !== "string" || d.userId !== userId || typeof d.logDate !== "string") return null;
  if (!Array.isArray(d.photos) || !d.answers || typeof d.answers !== "object") return null;
  const draft = d as AiDailyLogDraft;
  // A frozen payload from before actor binding was never sent with an actor;
  // it belongs to this draft's own account.
  const pending = draft.pending && !draft.pending.payload.actorId
    ? { ...draft.pending, payload: { ...draft.pending.payload, actorId: draft.userId, sourceRequestIds: draft.pending.payload.sourceRequestIds ?? [] } }
    : draft.pending;
  return { ...draft, sources: draft.sources ?? { conversationId: null, requestIds: [] }, pending };
}
