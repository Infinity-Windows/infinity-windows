// Wave T9: is this device's clock believable? Every timestamp this app writes
// used to be the SERVER's now(), so a wrong device clock could only make the
// live timer lie. Since Release 0 (K0.5, 20261028000000) a clock punch also
// carries the phone's own tap time, and pay USES that tap time — but only when
// this device compared its clock with the server within the last 24 hours and
// was found within 2 minutes of it. This module is that comparison's memory:
// it records each check, and hands every punch the stamp the server judges.

import { supabase } from "./supabase";

/** Past this much skew, the device clock is wrong enough to say something. */
export const CLOCK_SKEW_WARN_MS = 5 * 60_000;

/**
 * The server's rule for trusting a tap time (K0.5, owner decision): the check
 * is no older than a day, and the phone was within two minutes. Mirrored from
 * `_clock_pick_time` so the banner and the server agree on what "trusted" is.
 */
export const CLOCK_CHECK_MAX_AGE_MS = 24 * 3600_000;
export const CLOCK_TRUST_SKEW_MS = 2 * 60_000;

/**
 * How often a phone re-asks the server the time when nothing prompts it. Well
 * inside the 24-hour trust window, so a phone opened once in the morning is
 * still trusted for the evening clock-out with no signal in between.
 */
export const CLOCK_RECHECK_MS = 6 * 3600_000;

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

/** One comparison of this device's clock with the server's. */
export interface ClockCheck {
  /** When the check ran, by the device's clock. */
  deviceAtMs: number;
  /** When the check ran, by the server's clock — what the server measures age on. */
  serverAtMs: number;
  /** Device minus server at that moment. */
  skewMs: number;
}

const CHECK_KEY = "iw:clockCheck";
// The in-memory copy: a private window or a full disk must not turn every punch
// into "clock never checked" for as long as the app stays open.
let memoryCheck: ClockCheck | null = null;

/**
 * Remember a comparison. Device-local on purpose, like the dismissal below: the
 * skew is a property of THIS phone, and a check made on another device says
 * nothing about it.
 */
export function recordClockCheck(deviceNowMs: number, serverNowMs: number): ClockCheck {
  const check: ClockCheck = {
    deviceAtMs: deviceNowMs,
    serverAtMs: serverNowMs,
    skewMs: clockSkewMs(deviceNowMs, serverNowMs),
  };
  memoryCheck = check;
  try {
    localStorage.setItem(CHECK_KEY, JSON.stringify(check));
  } catch {
    // Storage full/blocked — the in-memory copy carries this session.
  }
  return check;
}

/** The last comparison this device made, or null if it never has. */
export function lastClockCheck(): ClockCheck | null {
  if (memoryCheck) return memoryCheck;
  try {
    const raw = localStorage.getItem(CHECK_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ClockCheck>;
    if (
      typeof v.deviceAtMs !== "number" ||
      typeof v.serverAtMs !== "number" ||
      typeof v.skewMs !== "number"
    ) {
      return null;
    }
    memoryCheck = { deviceAtMs: v.deviceAtMs, serverAtMs: v.serverAtMs, skewMs: v.skewMs };
    return memoryCheck;
  } catch {
    return null;
  }
}

/** For tests. */
export function forgetClockCheck(): void {
  memoryCheck = null;
  try {
    localStorage.removeItem(CHECK_KEY);
  } catch {
    /* nothing to forget */
  }
}

/**
 * What every clock punch sends beside its one-time id: the tap time by this
 * phone's clock, and the last check the server can judge that tap by. The
 * server — not the phone — decides whether the tap is trusted; this only
 * reports honestly. A phone that has never checked sends nulls and gets
 * arrival time plus a review mark, which is the right answer for it.
 */
export interface ClockTrustStamp {
  tappedAt: string;
  clockCheckedAt: string | null;
  clockSkewMs: number | null;
}

export function clockTrustStamp(nowMs = Date.now(), check = lastClockCheck()): ClockTrustStamp {
  return {
    tappedAt: new Date(nowMs).toISOString(),
    clockCheckedAt: check ? new Date(check.serverAtMs).toISOString() : null,
    clockSkewMs: check ? Math.round(check.skewMs) : null,
  };
}

/** Would the server trust a tap made now, going by this device's last check? */
export function clockCheckIsFresh(nowMs = Date.now(), check = lastClockCheck()): boolean {
  if (!check) return false;
  if (nowMs - check.deviceAtMs > CLOCK_CHECK_MAX_AGE_MS) return false;
  return Math.abs(check.skewMs) <= CLOCK_TRUST_SKEW_MS;
}

/**
 * Ask the server the time again if this device has not lately. Fire-and-forget
 * and silent: no signal is not a wrong clock, and the last good check stands.
 */
let inflight: Promise<ClockCheck | null> | null = null;

export async function ensureClockChecked(
  nowMs = Date.now(),
  maxAgeMs = CLOCK_RECHECK_MS,
): Promise<ClockCheck | null> {
  const last = lastClockCheck();
  if (last && nowMs - last.deviceAtMs < maxAgeMs && nowMs >= last.deviceAtMs) return last;
  // App start and sign-in land within the same instant; one question to the
  // server answers both.
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const serverMs = await fetchServerNowMs();
      return recordClockCheck(Date.now(), serverMs);
    } catch {
      return last;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

let installed = false;

/**
 * Wire the check to the moments a phone is likely to have signal: app start,
 * sign-in, coming back to the foreground, and the network returning. Once per
 * session, from main.tsx — the real bootstrap, which no test imports — rather
 * than from a provider every screen test mounts. `ensureClockChecked` throttles
 * itself, so this asks the server only a few times a day.
 */
export function installClockCheck(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  void ensureClockChecked();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void ensureClockChecked();
  });
  window.addEventListener("online", () => void ensureClockChecked());
  // server_now is granted to signed-in people only, so the start-up check on
  // a phone that has not signed in yet simply fails quietly; this is the check
  // that lands the moment it has.
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") void ensureClockChecked();
  });
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
