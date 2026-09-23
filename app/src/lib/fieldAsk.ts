import { supabase } from "./supabase";
import { dictationExtension } from "../../../supabase/functions/_shared/dictation";
import type { SetupChecklist, SetupDraft } from "../../../supabase/functions/_shared/fieldTools";
import type { LearningPrep } from "../../../supabase/functions/_shared/learningTools";
import type { AskArtifact } from "../../../supabase/functions/_shared/askReporting";
import type { KnowledgeSource } from "../../../supabase/functions/_shared/knowledge";

/**
 * Forge AI field requests on the phone.
 *
 * A field message is EVIDENCE before it is a command: it gets a stable request
 * id, the moment Send was pressed, the clock version the phone had read, and —
 * for voice — the original recording saved privately under the speaker's own
 * folder. The phone never claims a job, unit or timer changed; only the
 * database receipts returned with the answer (or a later tap on a choice) say so.
 */

export const FIELD_MEMO_BUCKET = "ai-field-memos";

export interface FieldOption { id: string; label: string }
/** A database receipt for one action. `status` is the only source of truth. */
export interface FieldReceipt {
  action_id: string;
  action: string;
  status: "done" | "running" | "needs_choice" | "stale" | "cancelled";
  outcome?: string;
  reason?: string;
  message?: string;
  options?: FieldOption[];
  preview_hash?: string;
  expires_at?: string;
  unit?: { unit_id: string; label: string; type: string; facts: Record<string, unknown>; assigned_to?: string | null } | null;
  project_id?: string;
  name?: string;
  location?: string;
  started_at?: string;
  device_sent_at?: string;
  start_time_basis?: "request_sent" | "tapped_start";
  stage?: string;
  participation?: string;
  differences?: Record<string, { stored?: unknown; plans?: unknown; said: unknown }>;
  matches?: { id: string; name: string; job_code?: string; location?: string | null }[];
  supervisor_notice?: { recipients: number; channel: string };
  people?: string[];
  work_date?: string;
  [key: string]: unknown;
}
/** `learning` is a write-up prepared on screen: never saved or sent by the reply itself. */
export interface FieldReply { request_id: string; receipts: FieldReceipt[]; checklist: SetupChecklist | null; draft?: SetupDraft; learning?: LearningPrep | null; replayed?: boolean }

/** What goes with a message so the server can bind it to the person and time. */
export interface FieldMeta {
  /** The account the message was captured under; the server refuses it for anyone else. */
  actor_id: string;
  request_id: string;
  conversation_id: string;
  input_kind: "text" | "voice";
  sent_at: string;
  clock_version: number | null;
  clock_pending_sync: boolean;
  audio_path?: string | null;
}

const conversationKey = (userId: string) => `forge.ai-field.conversation.${userId}`;
/** One guided setup per account on this phone; a new one on request. Another
 * account signing in here gets its own, and the server only ever returns a
 * person their own answers. */
export function currentConversation(userId: string): string {
  try {
    const saved = localStorage.getItem(conversationKey(userId));
    if (saved && /^[0-9a-f-]{36}$/i.test(saved)) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(conversationKey(userId), id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
export function startNewConversation(userId: string): string {
  const id = crypto.randomUUID();
  try { localStorage.setItem(conversationKey(userId), id); } catch { /* session-only is fine */ }
  return id;
}

/** The phone's view of its own job clock and timers, read BEFORE Send. Null
 * when it cannot be read (offline): the server then refuses timing actions. */
export async function readClockVersion(): Promise<number | null> {
  try {
    const { data, error } = await supabase.rpc("ai_field_clock_version");
    if (error) return null;
    const epoch = (data as { epoch?: unknown } | null)?.epoch;
    return typeof epoch === "number" && Number.isSafeInteger(epoch) ? epoch : null;
  } catch {
    return null;
  }
}

export function memoPath(userId: string, requestId: string, blob: Blob): string {
  return `${userId}/${requestId}/memo.${dictationExtension(blob.type) ?? "webm"}`;
}

/** Save the original recording. Idempotent for a retry of the same request. */
export async function uploadMemo(userId: string, requestId: string, blob: Blob): Promise<string> {
  const path = memoPath(userId, requestId, blob);
  const { error } = await supabase.storage.from(FIELD_MEMO_BUCKET).upload(path, blob, { contentType: blob.type || "audio/webm", upsert: false });
  // Already uploaded by an earlier attempt of this same request: that is the original.
  if (error && !/exists|duplicate/i.test(error.message)) throw error;
  return path;
}

export async function memoPlaybackUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(FIELD_MEMO_BUCKET).createSignedUrl(path, 600);
  return error ? null : data.signedUrl;
}

/** Is `userId` still the account this phone's Supabase client is signed in as?
 * Checked before every upload, transcription and Ask call a field message
 * makes, so a message captured under one account is never sent, transcribed
 * or paid for under another. */
export async function sessionUserIs(userId: string): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id === userId;
  } catch {
    return false;
  }
}

/** The person's own tap on a choice card. */
export async function resolveFieldChoice(receipt: FieldReceipt, choice: string): Promise<FieldReceipt> {
  const { data, error } = await supabase.rpc("ai_field_resolve", { p_action: receipt.action_id, p_choice: choice, p_preview_hash: receipt.preview_hash ?? null });
  if (error) throw error;
  return data as FieldReceipt;
}

/** Choices that start or resume a timer. */
export const TIMING_CHOICES = new Set(["start_now", "join_helper", "end_break_and_start"]);
export class TimingPendingError extends Error {
  constructor() { super("timing_pending"); this.name = "TimingPendingError"; }
}
/**
 * A tap on a timing choice re-checks, at the moment of the tap, that this phone
 * is not holding a clock or timer change the server has not seen (a break or
 * clock-out queued after the card appeared). Pending or unreadable ⇒ refused
 * before anything is sent. Non-timing choices (corrections, job duplicates,
 * cancel) are never blocked.
 */
export async function guardedResolve(
  receipt: FieldReceipt, choice: string,
  deps: { timingPending: () => Promise<boolean>; resolve?: typeof resolveFieldChoice },
): Promise<FieldReceipt> {
  if (TIMING_CHOICES.has(choice)) {
    let pending = true;
    try { pending = await deps.timingPending(); } catch { pending = true; }
    if (pending) throw new TimingPendingError();
  }
  return (deps.resolve ?? resolveFieldChoice)(receipt, choice);
}

export interface SavedTurn {
  id: string; transcript: string; input_kind: "text" | "voice"; sent_at: string; audio_path: string | null;
  /** The whole saved reply: report/job-summary cards and sources come back too. */
  reply: { answer?: string; toolActivity?: string[]; artifacts?: AskArtifact[]; sources?: KnowledgeSource[] } | null;
  captured: { checklist?: SetupChecklist | null; learning?: LearningPrep | null } | null; finished_at: string | null;
  receipts: FieldReceipt[];
}
/** How many recent messages a reload shows. The newest are always included;
 * the setup answers themselves live on the server and are never cut short. */
export const RESTORE_TURNS = 60;
/** Rebuild this account's conversation after a reload: what was said, what was
 * answered, and the current state of every receipt (a choice tapped on another
 * screen shows as decided here too). */
export async function loadConversation(userId: string, conversationId: string): Promise<SavedTurn[]> {
  const { data, error } = await supabase.from("ai_field_requests")
    .select("id,transcript,input_kind,sent_at,audio_path,reply,captured,finished_at")
    .eq("profile_id", userId).eq("conversation_id", conversationId)
    // Newest page first, then shown oldest-to-newest.
    .order("received_at", { ascending: false }).limit(RESTORE_TURNS);
  if (error) throw error;
  const turns = ((data ?? []) as Omit<SavedTurn, "receipts">[]).reverse();
  if (!turns.length) return [];
  const actions = await supabase.from("ai_field_actions").select("id,request_id,action,status,result,created_at")
    .in("request_id", turns.map((t) => t.id)).order("created_at", { ascending: true });
  if (actions.error) throw actions.error;
  const byRequest = new Map<string, FieldReceipt[]>();
  for (const a of (actions.data ?? []) as { id: string; request_id: string; action: string; status: string; result: FieldReceipt }[]) {
    const list = byRequest.get(a.request_id) ?? [];
    list.push({ ...a.result, action_id: a.id, action: a.action });
    byRequest.set(a.request_id, list);
  }
  return turns.map((t) => ({ ...t, receipts: byRequest.get(t.id) ?? [] }));
}

// ---------------------------------------------------------------------------
// Messages not yet sent (no signal, failed upload or transcription)
// ---------------------------------------------------------------------------
/** Kept on this phone under the account that recorded it. Sending later keeps
 * the original request id and Send time, so the server sees how old it is and
 * never starts or stops a timer from it. */
export interface UnsentField {
  userId: string;
  meta: FieldMeta;
  text: string;
  audio: Blob | null;
  error: string;
}
const DB = "forge-ai-field", STORE = "unsent";
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "meta.request_id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
/** Resolves only when the TRANSACTION commits. A request's success is not a
 * save: the transaction can still abort (quota, disk, eviction), and a phone
 * must never say an original recording is kept when it is not. */
export async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>, open: () => Promise<IDBDatabase> = openDb): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      let result: T;
      const r = run(t.objectStore(STORE));
      r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result);
      t.onabort = () => reject(t.error ?? r.error ?? new Error("storage_aborted"));
      t.onerror = () => reject(t.error ?? r.error ?? new Error("storage_failed"));
    });
  } finally { db.close(); }
}
/** Rejects when the phone cannot keep it — callers must show that, never "saved". */
export async function keepUnsent(item: UnsentField): Promise<void> {
  if (typeof indexedDB === "undefined") throw new Error("storage_unavailable");
  await tx("readwrite", (s) => s.put(item));
}
export async function dropUnsent(requestId: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await tx("readwrite", (s) => s.delete(requestId));
}
/** Only this account's unsent messages; another person's stay private. */
export async function listUnsent(userId: string): Promise<UnsentField[]> {
  if (typeof indexedDB === "undefined") return [];
  const all = await tx<UnsentField[]>("readonly", (s) => s.getAll() as IDBRequest<UnsentField[]>);
  return all.filter((u) => u.userId === userId).sort((a, b) => a.meta.sent_at.localeCompare(b.meta.sent_at));
}

/** Every query root a field receipt can change: custom work (as useWork.refresh
 * covers), the job clock, map ownership and jobs. Refreshed after any receipt
 * or choice so cached screens show a new claim or crew record at once. */
export const FIELD_QUERY_ROOTS = [
  "customWorkUnits", "customWorkSessions", "customWorkTypes", "customWorkHistory", "crewWorkRecords",
  "myOpenSession", "myActivePhases", "serviceActive", "serviceVisit",
  "openShift", "myOpenings", "openings", "openingAssignments", "customWorkCrewOpenings", "customWorkOpening", "projects",
] as const;

/**
 * Is this phone still holding a clock or unit-timer change the server has not
 * seen? A queued break or clock-out keeps the REAL shift id, and queued custom
 * work leaves the server's clock version unchanged, so neither shows up any
 * other way. Anything that cannot be read counts as pending: the server then
 * refuses timing actions, and the manual clock still works.
 */
export async function phoneTimingPending(
  userId: string,
  deps: { clockWrites: () => Promise<number>; workQueue: (userId: string) => { action: string }[]; shiftId: string | null | undefined },
): Promise<boolean> {
  try {
    if (deps.shiftId?.startsWith("pending:")) return true;
    if ((await deps.clockWrites()) > 0) return true;
    return deps.workQueue(userId).some((c) => c.action === "start" || c.action === "stop" || c.action === "session");
  } catch {
    return true;
  }
}

export type VoiceOutcome = { outcome: "sent" | "not_owner" | "empty" | "failed"; keptOnPhone: boolean; error?: string };
/**
 * A voice message, in order: keep it on the phone, then — only while this is
 * still the same screen and signed-in account — upload the original, then
 * transcribe, then send. The ownership check runs before EACH outside call, so
 * a recording made under one account is never uploaded, transcribed (paid
 * for) or sent under another; it stays kept for its speaker.
 */
export async function runVoiceSteps(steps: {
  stillOwner: () => Promise<boolean>;
  keep: (text: string, error: string) => Promise<boolean>;
  upload: () => Promise<string>;
  transcribe: () => Promise<string>;
  send: (words: string, audioPath: string) => void;
}): Promise<VoiceOutcome> {
  let keptOnPhone = await steps.keep("", "pending");
  try {
    if (!(await steps.stillOwner())) return { outcome: "not_owner", keptOnPhone };
    const path = await steps.upload();
    if (!(await steps.stillOwner())) return { outcome: "not_owner", keptOnPhone };
    const words = (await steps.transcribe()).trim();
    if (!words) { keptOnPhone = (await steps.keep("", "empty")) || keptOnPhone; return { outcome: "empty", keptOnPhone }; }
    keptOnPhone = (await steps.keep(words, "pending")) || keptOnPhone;
    if (!(await steps.stillOwner())) return { outcome: "not_owner", keptOnPhone };
    steps.send(words, path);
    return { outcome: "sent", keptOnPhone };
  } catch (e) {
    const error = e instanceof Error ? e.message : "failed";
    keptOnPhone = (await steps.keep("", error || "failed")) || keptOnPhone;
    return { outcome: "failed", keptOnPhone, error };
  }
}

/** Receipt statuses in words the Ask page shows, never inferred from model text. */
export function receiptDone(r: FieldReceipt): boolean {
  return r.status === "done" || r.status === "running";
}
