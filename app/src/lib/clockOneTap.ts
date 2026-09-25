import type { ClockButton, ClockBreakType } from "../../../supabase/functions/_shared/clockButtons";
import { endBreak as endBreakRpc, startBreak as startBreakRpc, type BreakType, type TimeShift } from "./timeclock";
import { enqueueBreakStart, enqueueBreakStop, resolveShiftRef as outboxResolveShiftRef } from "./offline/outbox";
import { isNetworkError } from "./offline/outbox-core";
import { isPendingShiftRef, mintPunch as mintClockPunch, type ClockPunch } from "./clockPunch";

/**
 * One-tap clock buttons under an Ask reply (crew redesign K2.4).
 *
 * The AI only OFFERS a button; this is what the person's tap does, and it is
 * the clock sheet's own path (ClockSheet.tsx doBreakStart / doBreakEnd): the
 * RPC first, and when the phone has no signal the same queued write the
 * sheet would make. Clock in and clock out are not done here at all — the
 * sheet owns their safety questions (toolbox, injury, hours), so those two
 * buttons open it.
 *
 * ONE PUNCH PER TAP (Release 0, K0.2 — Codex review of #641, 2026-09-25). The
 * punch, the tap's one-time id and tap time, is minted here, at the tap and
 * before the first try, and the SAME punch goes to the direct RPC and to the
 * queued fallback. The direct try can be saved by the server with its reply
 * lost on the way back; the queue then sends it again, and the server answers
 * the resend with the break it already started, because the id is the same.
 * A punch minted only for the queue would be a second tap the person never
 * made: a lunch started twice, or a stale break end closing the next break.
 *
 * A `pending:` shift (a clock-in still in the outbox) is never refused and
 * never sent to a uuid RPC. It goes where the queued-clock view and the sender
 * put it (#644): through the outbox's own resolveShiftRef, the map the sender
 * writes the moment a queued clock-in lands. Landed, it is that real shift and
 * the tap is tried directly. Not yet, and the punch is queued behind the
 * clock-in, exactly as the clock sheet queues it; the sender places it on the
 * shift the clock-in becomes, and the clock view shows it there meanwhile.
 */
export type OneTapOutcome =
  | { kind: "done"; action: ClockButton["action"]; queued: boolean }
  | { kind: "open_clock"; action: ClockButton["action"] }
  | {
      kind: "refused";
      // "unconfirmed": the direct try died on the network — so it may have been
      // saved — and the phone could not keep the punch to send again. Neither
      // "saved" nor "nothing changed" would be true.
      reason: "not_clocked_in" | "already_on_break" | "not_on_break" | "failed" | "unconfirmed";
    };

export interface OneTapDeps {
  startBreak: (shiftId: string, type: BreakType, punch: ClockPunch) => Promise<unknown>;
  endBreak: (shiftId: string, punch: ClockPunch) => Promise<unknown>;
  queueBreakStart: (shiftRef: string, type: string, punch: ClockPunch) => Promise<unknown>;
  queueBreakStop: (shiftRef: string, punch: ClockPunch) => Promise<unknown>;
  shouldQueue: (e: unknown) => boolean;
  /** The sender's pending→real shift map (lib/offline/outbox.ts, #644). */
  resolveShiftRef: (ref: string) => string | null;
  /** Stamp the tap: the one id and tap time every try of it carries. */
  mintPunch: () => ClockPunch;
}

export const defaultOneTapDeps = (): OneTapDeps => ({
  startBreak: startBreakRpc,
  endBreak: endBreakRpc,
  queueBreakStart: enqueueBreakStart,
  queueBreakStop: enqueueBreakStop,
  shouldQueue: isNetworkError,
  resolveShiftRef: outboxResolveShiftRef,
  mintPunch: () => mintClockPunch(),
});

/** Whether the button fits the person's clock right now; the reason if not. */
export function oneTapFits(action: ClockButton["action"], shift: TimeShift | null): OneTapOutcome | null {
  const open = shift && shift.status === "open" && !shift.clock_out_at ? shift : null;
  switch (action) {
    case "start_break":
      if (!open) return { kind: "refused", reason: "not_clocked_in" };
      if (open.break_started_at) return { kind: "refused", reason: "already_on_break" };
      return null;
    case "end_break":
      if (!open) return { kind: "refused", reason: "not_clocked_in" };
      if (!open.break_started_at) return { kind: "refused", reason: "not_on_break" };
      return null;
    case "clock_in":
    case "clock_out":
      return { kind: "open_clock", action };
  }
}

/** The person tapped a button. Never throws: every outcome is a sentence. */
export async function runOneTap(
  button: ClockButton,
  shift: TimeShift | null,
  breakType: ClockBreakType | null,
  deps: OneTapDeps = defaultOneTapDeps(),
): Promise<OneTapOutcome> {
  const unfit = oneTapFits(button.action, shift);
  if (unfit) return unfit;
  const action: "start_break" | "end_break" = button.action === "start_break" ? "start_break" : "end_break";
  const type: BreakType = breakType ?? button.break_type ?? "other";
  const ref = shift!.id;
  let punch: ClockPunch;
  let direct: string | null;
  try {
    // The tap's one punch, before anything is tried (see the header).
    punch = deps.mintPunch();
    // A real shift id, or the server's shift a landed clock-in became; null
    // while that clock-in is still on the phone.
    direct = isPendingShiftRef(ref) ? deps.resolveShiftRef(ref) : ref;
  } catch {
    return { kind: "refused", reason: "failed" };
  }

  let mayHaveLanded = false;
  if (direct) {
    try {
      if (action === "start_break") await deps.startBreak(direct, type, punch);
      else await deps.endBreak(direct, punch);
      return { kind: "done", action, queued: false };
    } catch (e) {
      // A refusal the server wrote is a refusal: nothing to resend.
      if (!deps.shouldQueue(e)) return { kind: "refused", reason: "failed" };
      mayHaveLanded = true;
    }
  }
  try {
    // The same punch, on the shift the direct try used — or behind the
    // clock-in that will become it.
    const on = direct ?? ref;
    if (action === "start_break") await deps.queueBreakStart(on, type, punch);
    else await deps.queueBreakStop(on, punch);
    return { kind: "done", action, queued: true };
  } catch {
    return { kind: "refused", reason: mayHaveLanded ? "unconfirmed" : "failed" };
  }
}
