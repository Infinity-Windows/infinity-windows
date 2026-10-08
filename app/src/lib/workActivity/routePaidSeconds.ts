// Selected-job production Work route (2026-10-04): the one paid-time number
// this route may show, derived from the SAME native current read
// ClockFlowBridge already observed for this exact login — never a second
// read, and never a fabricated zero.
//
// elapsedWorkSeconds only for a validated "ready" read, or a "stale" one
// frozen at its own observedAt (the caller must show a stale label beside
// it); every other currentRead — loading, blocked, unavailable, or no open
// native shift at all — reports null. This file never mutates payroll; it
// only reads what the bridge already computed.

import { elapsedWorkSeconds } from "../timeclock";
import { signInMark, type SignInMark } from "../signedIn";
import type { NativeClockFlow } from "../paidClock/flow";

export interface RoutePaidTime {
  seconds: number | null;
  /** True when `seconds` came from a frozen, no-longer-fresh observation —
   * the caller must show a stale label beside it, never present it as live. */
  stale: boolean;
}

export function routePaidSeconds(nativeFlow: NativeClockFlow | null, now: number, login: SignInMark = signInMark()): RoutePaidTime {
  if (!nativeFlow || !login.userId || nativeFlow.ownerId !== login.userId || nativeFlow.loginGeneration !== login.generation) return { seconds: null, stale: false };
  const current = nativeFlow.current;
  if (!current || current.kind !== "open" || current.shift.profile_id !== login.userId || current.shift.clock_out_at !== null) return { seconds: null, stale: false };
  if (nativeFlow.currentRead === "ready") {
    return { seconds: elapsedWorkSeconds(current.shift, now), stale: false };
  }
  if (nativeFlow.currentRead === "stale") {
    const observedAt = current.observedAt ? Date.parse(current.observedAt) : NaN;
    if (Number.isNaN(observedAt)) return { seconds: null, stale: true };
    return { seconds: elapsedWorkSeconds(current.shift, observedAt), stale: true };
  }
  // loading / blocked / unavailable: unknown, never a fabricated zero.
  return { seconds: null, stale: false };
}
