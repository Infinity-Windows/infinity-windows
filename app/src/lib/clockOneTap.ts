import type { ClockButton, ClockBreakType } from "../../../supabase/functions/_shared/clockButtons";
import { endBreak as endBreakRpc, startBreak as startBreakRpc, type BreakType, type TimeShift } from "./timeclock";
import { enqueueBreakStart, enqueueBreakStop } from "./offline/outbox";
import { isNetworkError } from "./offline/outbox-core";

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
 * `pending:` shift ids (a clock-in still in the outbox) are never sent to a
 * UUID RPC — the K0.4 rule; the person is told to let it sync.
 */
export type OneTapOutcome =
  | { kind: "done"; action: ClockButton["action"]; queued: boolean }
  | { kind: "open_clock"; action: ClockButton["action"] }
  | { kind: "refused"; reason: "not_clocked_in" | "already_on_break" | "not_on_break" | "pending" | "failed" };

export interface OneTapDeps {
  startBreak: (shiftId: string, type: BreakType) => Promise<unknown>;
  endBreak: (shiftId: string) => Promise<unknown>;
  queueBreakStart: (shiftId: string, type: string) => Promise<unknown>;
  queueBreakStop: (shiftId: string) => Promise<unknown>;
  shouldQueue: (e: unknown) => boolean;
}

export const defaultOneTapDeps = (): OneTapDeps => ({
  startBreak: startBreakRpc,
  endBreak: endBreakRpc,
  queueBreakStart: enqueueBreakStart,
  queueBreakStop: enqueueBreakStop,
  shouldQueue: isNetworkError,
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
  const id = shift!.id;
  // A queued clock-in has no server id yet; a break on it would be sent to a
  // UUID RPC as "pending:…" and fail — or worse, be queued behind it and
  // land on nothing.
  if (id.startsWith("pending:")) return { kind: "refused", reason: "pending" };
  try {
    if (button.action === "start_break") {
      const type: BreakType = breakType ?? button.break_type ?? "other";
      try {
        await deps.startBreak(id, type);
        return { kind: "done", action: "start_break", queued: false };
      } catch (e) {
        if (!deps.shouldQueue(e)) throw e;
        await deps.queueBreakStart(id, type);
        return { kind: "done", action: "start_break", queued: true };
      }
    }
    try {
      await deps.endBreak(id);
      return { kind: "done", action: "end_break", queued: false };
    } catch (e) {
      if (!deps.shouldQueue(e)) throw e;
      await deps.queueBreakStop(id);
      return { kind: "done", action: "end_break", queued: true };
    }
  } catch {
    return { kind: "refused", reason: "failed" };
  }
}
