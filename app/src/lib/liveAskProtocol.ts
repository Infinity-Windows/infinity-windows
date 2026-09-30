/**
 * GPT-Live data channel events checked against the 2026-09-30 Live guides.
 * GPT-Live sends transcript DELTAS with no completed-turn marker or item ID.
 * The delegation event is the only reliable task boundary for this app. At
 * that boundary we cut a source audio segment, transcribe the saved bytes
 * through Forge's existing endpoint, then pass that exact text into Ask.
 */

export const DELEGATION_CREATED = "session.delegation.created";
export const COMMENTARY_APPEND = "session.commentary.append";

export type LiveEvent =
  | { kind: "delegation"; delegationId: string }
  | { kind: "started" }
  | { kind: "closed"; seconds: number | null }
  | { kind: "usage"; seconds: number | null }
  | { kind: "error"; code: string }
  | { kind: "other" };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** One data-channel message in, one recognized shape out. Never throws. */
export function readLiveEvent(raw: unknown): LiveEvent {
  let e: Record<string, unknown>;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return { kind: "other" };
    e = parsed as Record<string, unknown>;
  } catch {
    return { kind: "other" };
  }
  const type = str(e.type);
  if (!type) return { kind: "other" };
  if (type === "session.started") return { kind: "started" };
  if (type === "session.closed" || type === "session.usage.updated") {
    const usage = e.usage && typeof e.usage === "object" ? e.usage as Record<string, unknown> : null;
    const seconds = typeof usage?.seconds === "number" && Number.isFinite(usage.seconds) ? usage.seconds : null;
    return type === "session.closed" ? { kind: "closed", seconds } : { kind: "usage", seconds };
  }
  if (type === DELEGATION_CREATED) {
    const d = e.delegation && typeof e.delegation === "object" ? (e.delegation as Record<string, unknown>) : null;
    const delegationId = str(d?.id);
    if (!delegationId) return { kind: "other" };
    return { kind: "delegation", delegationId };
  }
  if (type === "error") {
    const err = e.error && typeof e.error === "object" ? (e.error as Record<string, unknown>) : null;
    return { kind: "error", code: str(err?.code) ?? str(err?.type) ?? "provider_error" };
  }
  return { kind: "other" };
}

/** Longest verified result handed back to the voice; the screen has the rest. */
export const COMMENTARY_MAX_CHARS = 1_200;

/** The only event the phone sends: Ask's verified result for one delegation. */
export function commentaryEvent(delegationId: string, content: string): string {
  const text = content.length > COMMENTARY_MAX_CHARS ? `${content.slice(0, COMMENTARY_MAX_CHARS - 1)}…` : content;
  return JSON.stringify({ type: COMMENTARY_APPEND, delegation_id: delegationId, content: text });
}
