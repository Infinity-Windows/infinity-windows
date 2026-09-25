// The seam between the Ask page and the Forge AI daily log card. Ask owns the
// conversation (composer, microphone, recordings, field requests); this module
// owns what a daily log draft sends with a message and what it accepts back.
// Wiring steps: .scratch/ai-daily-logs/INTEGRATION.md.
import {
  asksForDailyLog,
  DAILY_LOG_PRESET,
  type DailyLogAskContext,
} from "../../../../supabase/functions/_shared/aiDailyLog";
import { isFrozen, type AiDailyLogDraft, type DailyLogJobRef } from "./draft";
import type { AiDailyLogController } from "./useAiDailyLogDraft";

export { asksForDailyLog, DAILY_LOG_PRESET };

/** The visible preset chip, in the person's language. */
export function dailyLogSuggestion(lang: "en" | "es"): { label: string; query: string } {
  return { label: DAILY_LOG_PRESET.label[lang], query: DAILY_LOG_PRESET.query[lang] };
}

/**
 * What goes beside an Ask message while a draft is open (`daily_log` in the
 * request body). Nothing once Save was pressed: a frozen or saved entry takes
 * no more answers. Captions are not sent; only how many photos there are.
 */
export function dailyLogAskContext(draft: AiDailyLogDraft | null): DailyLogAskContext | null {
  if (!draft || isFrozen(draft)) return null;
  return {
    draft_id: draft.id,
    actor_id: draft.userId,
    log_date: draft.logDate,
    job: draft.job ? { project_id: draft.job.projectId, label: draft.job.label } : null,
    answers: draft.answers,
    locked: draft.locked,
    photo_count: draft.photos.length,
    conversation_id: draft.sources?.conversationId ?? null,
  };
}

/**
 * Call for EVERY outgoing Ask message — typed, or a voice memo once it is
 * transcribed — before the request is built. If the message asks for the daily
 * log, or the card is already open, the draft is started or resumed and the
 * context is built from the draft `start` RETURNS. A React closure over
 * `controller.draft` would still be null on the very first message, and that
 * message ("build my daily log — I set six frames with Ben") would reach the
 * model with no tool, its facts lost.
 */
export async function dailyLogContextForMessage(
  controller: Pick<AiDailyLogController, "start" | "snapshot">,
  text: string,
  opts: { cardOpen: boolean; suggestedJob?: DailyLogJobRef | null },
): Promise<{ open: boolean; context: DailyLogAskContext | null }> {
  if (!opts.cardOpen && !asksForDailyLog(text)) return { open: false, context: null };
  const started = await controller.start({ suggestedJob: opts.suggestedJob ?? null });
  return { open: true, context: dailyLogAskContext(started ?? controller.snapshot()) };
}

export interface DailyLogAskReply {
  draft_id: string;
  actor_id: string;
  tool_inputs: unknown[];
  /** The Ask message this came from (ai_field_requests id) — kept as evidence. */
  request_id: string | null;
  conversation_id: string | null;
  /** Jobs the reply found by name (e.g. from get_field_context matches). Offered only. */
  job_candidates?: { project_id: string; label: string }[];
}

export function readDailyLogReply(raw: unknown): DailyLogAskReply | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.draft_id !== "string" || typeof r.actor_id !== "string" || !Array.isArray(r.tool_inputs)) return null;
  const candidates = Array.isArray(r.job_candidates)
    ? r.job_candidates.filter((c): c is { project_id: string; label: string } =>
      Boolean(c) && typeof (c as { project_id?: unknown }).project_id === "string" && typeof (c as { label?: unknown }).label === "string")
    : undefined;
  return {
    draft_id: r.draft_id, actor_id: r.actor_id, tool_inputs: r.tool_inputs,
    request_id: typeof r.request_id === "string" ? r.request_id : null,
    conversation_id: typeof r.conversation_id === "string" ? r.conversation_id : null,
    ...(candidates ? { job_candidates: candidates } : {}),
  };
}

export type DailyLogReplyResult =
  | { applied: true }
  /** Not for this draft / signed-in account / conversation: ignored. */
  | { applied: false; reason: "not_this_draft" }
  /** No saved Ask message behind it (no request_id or conversation_id): the
   * words were NOT recorded. The host must say so, never show them as taken. */
  | { applied: false; reason: "missing_evidence" }
  | { applied: false; reason: "unreadable" };

/**
 * Apply a reply to the open card. Refused unless it is for this draft, this
 * signed-in account and this draft's conversation, and unless it names the
 * saved Ask message it came from — every answer in an entry has evidence.
 * Candidates are offered, never chosen, and never move a photo.
 */
export function applyDailyLogReply(
  controller: Pick<AiDailyLogController, "snapshot" | "actor" | "applyModelReply" | "offerJobs">,
  raw: unknown,
): DailyLogReplyResult {
  const reply = readDailyLogReply(raw);
  if (!reply) return { applied: false, reason: "unreadable" };
  const draft = controller.snapshot();
  if (!draft || reply.draft_id !== draft.id || reply.actor_id !== draft.userId || controller.actor?.userId !== draft.userId) {
    return { applied: false, reason: "not_this_draft" };
  }
  const conv = draft.sources?.conversationId;
  if (conv && reply.conversation_id && reply.conversation_id !== conv) return { applied: false, reason: "not_this_draft" };
  // Answers need the saved message they came from; job candidates are only
  // offered as buttons, so they need none.
  if (reply.tool_inputs.length && (!reply.request_id || !reply.conversation_id)) return { applied: false, reason: "missing_evidence" };
  for (const toolInput of reply.tool_inputs) {
    controller.applyModelReply({ draftId: reply.draft_id, userId: reply.actor_id, toolInput, requestId: reply.request_id!, conversationId: reply.conversation_id! });
  }
  if (reply.job_candidates?.length) {
    controller.offerJobs(reply.job_candidates.map((c): DailyLogJobRef => ({ projectId: c.project_id, label: c.label })));
  }
  return { applied: true };
}
