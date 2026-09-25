// One clock punch, as the server wants to hear about it (Release 0, K0.2/K0.5,
// 20261028000000): a one-time id that makes a resend the SAME punch, and the
// tap time with the clock check the server judges it by.
//
// The id is minted at the tap, before the first try, and reused by every retry
// of that tap — the direct call, the hand-off from the landing block to the
// clock sheet, the offline queue's eight attempts. That is the whole rule: a
// tap gets one id for life. Minting a fresh id on a retry is how a lost reply
// became a double punch.

import { clockTrustStamp, type ClockTrustStamp } from "./clockSkew";

export interface ClockPunch extends ClockTrustStamp {
  /** The one-time id — the server's idempotency key for this tap. */
  clientId: string;
}

export function newClockActionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // No crypto.randomUUID (an old WebView): still a v4-shaped id the uuid column
  // accepts, drawn from Math.random — collisions are astronomically unlikely
  // and, being scoped to one person's own punches, harmless.
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const s = (n: number) => Array.from({ length: n }, hex).join("");
  return `${s(8)}-${s(4)}-4${s(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${s(3)}-${s(12)}`;
}

/**
 * Stamp a tap: a fresh id unless the caller is retrying a tap that already has
 * one, plus the tap time and this device's last clock check.
 */
export function mintPunch(clientId?: string | null, nowMs = Date.now()): ClockPunch {
  return { clientId: clientId || newClockActionId(), ...clockTrustStamp(nowMs) };
}

/**
 * A tap handed from one screen to another (the landing block or Start day to
 * the clock sheet), as it should be sent now. It is the SAME punch — its id,
 * its tap time and its clock check, never re-stamped at the later screen's
 * tap: a first request that never reached the server would otherwise be paid
 * from that later tap (Codex review of #640, 2026-09-25).
 *
 * One exception: today's toolbox talk signed AFTER the tap. Then it is
 * stamped at the signature instead, under the same id: paid time does not
 * start before the talk, and signing is what made this clock-in possible —
 * the rule the landing block and Start day follow when signing IS the
 * clock-in. `signedAt` is the completion's signed_at, which the signing phone
 * stamps with its own clock (lib/toolbox.ts), the same clock as the tap.
 */
export function carriedPunch(punch: ClockPunch, signedAt: string | null | undefined): ClockPunch {
  const signedMs = signedAt ? Date.parse(signedAt) : Number.NaN;
  if (!Number.isFinite(signedMs) || signedMs <= Date.parse(punch.tappedAt)) return punch;
  return mintPunch(punch.clientId, signedMs);
}

/**
 * A shift id the phone made up for a clock-in that has not reached the server
 * yet (`pending:<outbox entry id>`, see lib/offline/outbox.ts). It is not a
 * uuid and no RPC may ever be handed it: the server answers "invalid input
 * syntax for type uuid", which is neither a network error (so it is not
 * queued) nor anything an installer can act on. Every screen that sends a
 * shift id checks this first and queues the action behind the clock-in instead.
 */
export const PENDING_SHIFT_PREFIX = "pending:";

export function isPendingShiftRef(ref: string | null | undefined): boolean {
  return typeof ref === "string" && ref.startsWith(PENDING_SHIFT_PREFIX);
}
