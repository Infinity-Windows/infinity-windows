// A clock punch still on the phone counts as real (Release 0, K0.1).
//
// The clock used to read only the server's shift. A clock-in tapped in a dead
// zone went into the outbox and the screens dropped back to "off the clock"
// the moment the next server read came back empty — which is when the person,
// seeing no clock-in, tapped Start again and made the double punch. This
// module folds the queued punches onto the server's answer, in tap order, so
// what every clock screen shows is what the server WILL hold once the phone
// finds signal: clocked in from the tap time, on break, back at work, or
// clocked out. Pure — no store, no React — so the rules are provable.
//
// A punch the queue has given up on ("failed") is NOT applied: the server
// refused it, or the phone did, and the person has to know. It comes back as
// `refused`, with the reason, and the screens say so and point at /stuck.

import { PENDING_SHIFT_PREFIX } from "./clockPunch";
import { isClockOp, type OutboxEntry } from "./offline/outbox-core";
import type { BreakType, TimeShift } from "./timeclock";
import type { JobMode } from "./types";

export type ClockActionKind = "clock_in" | "break_start" | "break_stop" | "clock_out";

/** A punch saved on this phone that has not reached the server yet. */
export interface QueuedClockAction {
  kind: ClockActionKind;
  entryId: string;
  /** When the person tapped, by the phone's clock (ISO). */
  tappedAt: string;
  /** True while a drain is attempting it this instant. */
  sending: boolean;
}

/** A punch the queue has stopped trying to send. It is listed on /stuck. */
export interface RefusedClockAction {
  kind: ClockActionKind;
  entryId: string;
  tappedAt: string;
  reason: string | null;
}

export interface ClockQueueView {
  /** The shift as it will stand once every queued punch has landed. */
  shift: TimeShift | null;
  /** The newest punch still on the phone, or null when the server has it all. */
  pending: QueuedClockAction | null;
  /** Punches that were refused, oldest first. */
  refused: RefusedClockAction[];
}

/**
 * Names for a queued clock-in's job and cost code, looked up by the caller
 * (the query cache, in the app). The queue carries ids only; a shift made up
 * from one still has to read "BLACK22 · Black Desert" on the nav and the
 * sheet, the way the server's row does.
 */
export interface ClockNameLookups {
  project?: (id: string) => { job_code: string; name: string } | null | undefined;
  costCode?: (
    id: string,
    projectId: string | null,
  ) => { code: string; label: string } | null | undefined;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** The tap time the entry carries; the moment it was queued for one that predates tap times. */
function tapTimeOf(e: OutboxEntry): string {
  return str(e.payload.tappedAt) ?? new Date(e.createdAt).toISOString();
}

/**
 * Which server shift a `pending:<entry id>` ref stands for, once known. The
 * sender keeps this map (lib/offline/outboxHandlers.ts, createShiftResolver,
 * persisted on the phone) and writes to it the moment a queued clock-in is
 * accepted. A break or clock-out queued behind that clock-in carries the
 * pending ref for life, and once the clock-in has left the queue nothing in
 * the queue names it any more — only this map still knows the ref is the
 * server's row. Without it, a queued clock-out showed "clocked in, clock-out
 * on its way" over a shift the phone was about to close, and kept showing
 * it across relaunches (Codex review of #644, 2026-09-24).
 */
export type ShiftRefResolver = (ref: string) => string | null;

/**
 * Pending refs learned during one merge pass: a queued clock-in whose tap the
 * server already holds (the reply was lost, or the entry is still being
 * deleted) is the server's row, so the punches behind it that name
 * `pending:<its entry id>` belong to that row too. Learned here rather than
 * from the resolver because at that instant the sender may not have recorded
 * it yet.
 */
type PendingAliases = Map<string, string>;

/** Does this queued break / clock-out belong to the shift the view shows? */
function refMatches(
  shift: TimeShift,
  ref: string | null,
  aliases: PendingAliases,
  resolve: ShiftRefResolver | undefined,
): boolean {
  if (ref == null) return false;
  if (ref === shift.id) return true;
  if (!ref.startsWith(PENDING_SHIFT_PREFIX)) return false;
  const real = aliases.get(ref) ?? resolve?.(ref) ?? null;
  return real != null && real === shift.id;
}

function wholeSecondsBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 1000));
}

/**
 * The shift a queued clock-in stands for, id `pending:<entry id>` so every
 * screen's guard (isPendingShiftRef) treats it as one still on the phone.
 * Starts at the TAP time: that is what the server pays from when it trusts
 * the phone (K0.5), and what the nav timer should count from meanwhile.
 */
function shiftFromQueuedClockIn(
  e: OutboxEntry,
  tappedAt: string,
  profileId: string,
  lookups: ClockNameLookups,
): TimeShift {
  const p = e.payload;
  const projectId = str(p.projectId);
  const costCodeId = str(p.costCodeId);
  const mode = str(p.mode);
  const project = projectId ? lookups.project?.(projectId) ?? null : null;
  const costCode = costCodeId ? lookups.costCode?.(costCodeId, projectId) ?? null : null;
  return {
    id: PENDING_SHIFT_PREFIX + e.id,
    client_id: str(p.clientId),
    profile_id: profileId,
    project_id: projectId,
    cost_code_id: costCodeId,
    clock_in_at: tappedAt,
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: tappedAt,
    note: str(p.note),
    job_mode: mode === "data" || mode === "tracking" ? (mode as JobMode) : null,
    clock_in_lat: num(p.lat),
    clock_in_lng: num(p.lng),
    projects: project ? { job_code: project.job_code, name: project.name } : null,
    cost_codes: costCode ? { code: costCode.code, label: costCode.label } : null,
  };
}

function applyQueued(
  shift: TimeShift | null,
  e: OutboxEntry,
  kind: ClockActionKind,
  tappedAt: string,
  profileId: string,
  lookups: ClockNameLookups,
  aliases: PendingAliases,
  resolve: ShiftRefResolver | undefined,
): TimeShift | null {
  const p = e.payload;
  switch (kind) {
    case "clock_in": {
      // The server already has THIS tap (the reply was lost and the queue is
      // resending it): its row is the truth, and it will answer the resend
      // with the same row. Anything else — no shift, an older shift this
      // clock-in will close, a made-up shift from a previous merge — gives
      // way to the queued punch.
      const clientId = str(p.clientId);
      if (shift && shift.status === "open" && clientId && shift.client_id === clientId) {
        aliases.set(PENDING_SHIFT_PREFIX + e.id, shift.id);
        return shift;
      }
      return shiftFromQueuedClockIn(e, tappedAt, profileId, lookups);
    }
    case "break_start": {
      if (!shift || !refMatches(shift, str(p.shiftRef), aliases, resolve) || shift.break_started_at) return shift;
      const breakType = str(p.breakType);
      return {
        ...shift,
        break_started_at: tappedAt,
        break_type: (breakType as BreakType | null) ?? null,
      };
    }
    case "break_stop": {
      if (!shift || !refMatches(shift, str(p.shiftRef), aliases, resolve) || !shift.break_started_at) return shift;
      return {
        ...shift,
        break_seconds: (shift.break_seconds ?? 0) + wholeSecondsBetween(shift.break_started_at, tappedAt),
        break_started_at: null,
        break_type: null,
      };
    }
    case "clock_out":
      return shift && refMatches(shift, str(p.shiftRef), aliases, resolve) ? null : shift;
  }
}

export interface MergeClockQueueOptions {
  profileId: string | null;
  lookups?: ClockNameLookups;
  /**
   * The sender's memory of which server shift each queued clock-in became.
   * Pass the outbox's own (lib/offline/outbox.ts, resolveShiftRef) so the
   * screens and the sender agree on what a pending ref means after the
   * clock-in has landed and left the queue. Without one, a punch behind a
   * clock-in that has already left the queue cannot be placed and leaves the
   * server's row as it is.
   */
  resolveShiftRef?: ShiftRefResolver;
}

/**
 * The server's shift with the phone's queued punches applied, in tap order.
 *
 * `server` is the last server answer the caller holds — the live read, or
 * the copy the phone kept from before the signal went. `undefined` (nothing
 * read yet) is treated as no shift; the queue still speaks for itself, which
 * is what a relaunch with no signal needs.
 */
export function mergeClockQueue(
  server: TimeShift | null | undefined,
  entries: readonly OutboxEntry[],
  opts: MergeClockQueueOptions,
): ClockQueueView {
  const lookups = opts.lookups ?? {};
  const profileId = opts.profileId ?? server?.profile_id ?? "";
  const aliases: PendingAliases = new Map();
  let shift: TimeShift | null = server ?? null;
  let pending: QueuedClockAction | null = null;
  const refused: RefusedClockAction[] = [];
  const punches = entries
    .filter((e) => isClockOp(e.op))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const e of punches) {
    const kind = e.op as ClockActionKind;
    const tappedAt = tapTimeOf(e);
    if (e.status === "failed") {
      refused.push({ kind, entryId: e.id, tappedAt, reason: e.lastError });
      continue;
    }
    shift = applyQueued(shift, e, kind, tappedAt, profileId, lookups, aliases, opts.resolveShiftRef);
    pending = { kind, entryId: e.id, tappedAt, sending: e.status === "sending" };
  }
  return { shift, pending, refused };
}

/**
 * What a confirmed punch leaves as the server's shift (K0.1). The drain hands
 * over the row the RPC answered with; a clock-out answers with the closed row,
 * which as an OPEN shift is nothing. `undefined` means the answer was not a
 * row at all, and the caller should leave its cache alone.
 */
export function confirmedOpenShift(
  kind: ClockActionKind,
  result: unknown,
): TimeShift | null | undefined {
  if (kind === "clock_out") return null;
  if (!result || typeof result !== "object") return undefined;
  const row = result as Partial<TimeShift>;
  if (typeof row.id !== "string" || typeof row.clock_in_at !== "string") return undefined;
  return row.clock_out_at == null && (row.status ?? "open") === "open" ? (row as TimeShift) : null;
}

/** "7:02 AM" from an ISO tap time, in the phone's own locale — the status line's time. */
export function tapTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The entry id behind a `pending:` shift ref, or null for a real shift id. */
export function pendingEntryIdOf(ref: string | null | undefined): string | null {
  return typeof ref === "string" && ref.startsWith(PENDING_SHIFT_PREFIX)
    ? ref.slice(PENDING_SHIFT_PREFIX.length)
    : null;
}
