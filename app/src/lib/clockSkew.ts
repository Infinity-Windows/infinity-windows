// Wave T9: is this device's clock believable? Every timestamp this app
// writes is the SERVER's now() (every RPC in this codebase stamps its own
// clock, never a client-supplied one), so a wrong device clock cannot
// corrupt a recorded time — but it can make the LIVE TIMER on screen lie to
// whoever is looking at it, which is worth its own quiet warning.

import { supabase } from "./supabase";

/** Past this much skew, the device clock is wrong enough to say something. */
export const CLOCK_SKEW_WARN_MS = 5 * 60_000;

/** The server's own clock, in epoch ms, for a device to diff itself against. */
export async function fetchServerNowMs(): Promise<number> {
  const { data, error } = await supabase.rpc("server_now");
  if (error) throw error;
  return new Date(data as string).getTime();
}

/** Device time minus server time — positive means the device is running ahead. */
export function clockSkewMs(deviceNowMs: number, serverNowMs: number): number {
  return deviceNowMs - serverNowMs;
}

export function isClockSkewed(skewMs: number): boolean {
  return Math.abs(skewMs) > CLOCK_SKEW_WARN_MS;
}

const DISMISS_PREFIX = "iw:clockSkewDismissed:";

/**
 * Device-local, deliberately NOT the server-synced notification_dismissals
 * table: a wrong clock is a property of THIS device, so dismissing it here
 * must never silently suppress the same warning on a phone that is
 * actually still wrong. Keyed by calendar day so it re-warns daily.
 */
export function clockSkewDismissedToday(day: string): boolean {
  try {
    return localStorage.getItem(DISMISS_PREFIX + day) === "1";
  } catch {
    return false;
  }
}

export function dismissClockSkewToday(day: string): void {
  try {
    localStorage.setItem(DISMISS_PREFIX + day, "1");
  } catch {
    // Storage full/blocked — worst case it just asks again today.
  }
}
