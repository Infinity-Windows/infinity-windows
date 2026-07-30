import { elapsedMinutes, AUTO_TIMER_CAP_MINUTES } from "./installTimer";

/**
 * Device memory of when an install was started, for the case the server could
 * not be told at the time.
 *
 * `start_opening_work` is the authority on when work began, and its stamp
 * survives a refresh, a reinstall and a new phone. It also needs signal, and
 * installers routinely work where there is none — the whole install submit
 * path goes through an outbox for exactly that reason. Without this, tapping
 * "Start install" in a dead zone would time nothing at all and the installer
 * would be back to guessing the number by hand.
 *
 * Kept per-device in localStorage, same as the opening trail: small, available
 * offline, and never the source of truth when the server has an answer.
 */

const START_KEY = "iw-install-start";
/** A job's worth of openings; oldest fall off the end. */
const START_LIMIT = 100;

type Starts = Record<string, string>;

/** Fallback for private mode, a full quota, or a non-browser context. */
let memoryStarts: Starts = {};

function readStarts(): Starts {
  try {
    const raw = localStorage.getItem(START_KEY);
    if (!raw) return { ...memoryStarts };
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Starts) : {};
  } catch {
    return { ...memoryStarts };
  }
}

function writeStarts(starts: Starts): void {
  memoryStarts = starts;
  try {
    localStorage.setItem(START_KEY, JSON.stringify(starts));
  } catch {
    // Private mode or a full quota: the in-memory copy still covers this
    // session, which is the case that matters mid-install.
  }
}

/** Note that work began on this opening, if we hadn't already. */
export function rememberLocalStart(openingId: string, startedAt: string): void {
  if (!openingId || !startedAt) return;
  const starts = readStarts();
  if (starts[openingId]) return; // First tap wins; re-tapping must not reset it.

  starts[openingId] = startedAt;
  const keys = Object.keys(starts);
  if (keys.length > START_LIMIT) {
    for (const key of keys.slice(0, keys.length - START_LIMIT)) delete starts[key];
  }
  writeStarts(starts);
}

/**
 * When did work begin on this opening according to this device?
 *
 * A stamp older than the auto-timer's cap is not a running install, it is a
 * tap someone forgot about days ago, and resurrecting it would put a wild
 * number in front of them. Those are ignored and cleared.
 */
export function recallLocalStart(openingId: string, now = Date.now()): string | null {
  if (!openingId) return null;
  const startedAt = readStarts()[openingId];
  if (!startedAt) return null;

  const minutes = elapsedMinutes(startedAt, now);
  if (minutes == null || minutes > AUTO_TIMER_CAP_MINUTES) {
    forgetLocalStart(openingId);
    return null;
  }
  return startedAt;
}

/** Drop this opening's local start (it submitted, or it went stale). */
export function forgetLocalStart(openingId: string): void {
  if (!openingId) return;
  const starts = readStarts();
  if (!(openingId in starts)) return;
  delete starts[openingId];
  writeStarts(starts);
}

/** Test seam / sign-out: forget every remembered start on this device. */
export function forgetAllLocalStarts(): void {
  memoryStarts = {};
  try {
    localStorage.removeItem(START_KEY);
  } catch {
    // Nothing to do; this memory is best-effort by design.
  }
}
