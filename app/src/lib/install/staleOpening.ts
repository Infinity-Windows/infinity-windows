import { openingMarkCode } from "./types";

/**
 * Re-extraction deletes the old `project_openings` rows and inserts new ones
 * with fresh UUIDs, so any link or open phone screen holding the old id points
 * at nothing. The wall the installer is standing at has not moved: the same
 * opening is on the new planset under the same code (`9-1`), or at worst the
 * same mark (`9`).
 *
 * These helpers turn a dead id back into the live opening. What we remember is
 * only the code, kept per-device — small enough to sit in localStorage and
 * available with no signal, which is where the phone usually is.
 */

const TRAIL_KEY = "iw-opening-trail";
/** Plenty for a job's worth of screens; oldest entries fall off the end. */
const TRAIL_LIMIT = 300;

export interface OpeningTrailEntry {
  projectId: string;
  code: string;
}

type Trail = Record<string, OpeningTrailEntry>;

/** Fallback for private mode, a full quota, or a non-browser context. */
let memoryTrail: Trail = {};

function readTrail(): Trail {
  try {
    const raw = localStorage.getItem(TRAIL_KEY);
    if (!raw) return { ...memoryTrail };
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Trail) : {};
  } catch {
    return { ...memoryTrail };
  }
}

function writeTrail(trail: Trail): void {
  memoryTrail = trail;
  try {
    localStorage.setItem(TRAIL_KEY, JSON.stringify(trail));
  } catch {
    // Private mode or a full quota: recovery is a nicety, never a blocker.
  }
}

/** Note which code an id stood for, so a later dead link can be recovered. */
export function rememberOpening(
  openingId: string,
  projectId: string,
  code: string,
): void {
  if (!openingId || !code) return;
  const trail = readTrail();
  if (trail[openingId]?.code === code) return;
  delete trail[openingId];
  trail[openingId] = { projectId, code };

  const keys = Object.keys(trail);
  if (keys.length > TRAIL_LIMIT) {
    for (const key of keys.slice(0, keys.length - TRAIL_LIMIT)) delete trail[key];
  }
  writeTrail(trail);
}

/** What code did this (now dead) opening id stand for on this device? */
export function recallOpening(openingId: string): OpeningTrailEntry | null {
  if (!openingId) return null;
  return readTrail()[openingId] ?? null;
}

export function forgetOpeningTrail(): void {
  memoryTrail = {};
  try {
    localStorage.removeItem(TRAIL_KEY);
  } catch {
    // Nothing to do; the trail is best-effort.
  }
}

export interface OpeningLike {
  id: string;
  opening_code: string;
  status?: string | null;
}

export interface OpeningRecovery<T extends OpeningLike> {
  opening: T;
  /** Same code on the new planset — safe to send them straight there. */
  exact: boolean;
}

/**
 * Find where a lost opening went on the current planset.
 *
 * An exact code match is the same physical opening and can be followed without
 * asking. Failing that, another opening of the same mark is the same TYPE of
 * window in the same job — worth offering, but not silently. Anything already
 * installed is the last thing we'd send someone to.
 */
export function findReplacementOpening<T extends OpeningLike>(
  openings: T[],
  lostCode: string,
): OpeningRecovery<T> | null {
  const wanted = lostCode.trim().replace(/^#/, "").toUpperCase();
  if (!wanted) return null;

  const codeOf = (o: T) => o.opening_code.trim().replace(/^#/, "").toUpperCase();

  const exact = openings.find((o) => codeOf(o) === wanted);
  if (exact) return { opening: exact, exact: true };

  const mark = openingMarkCode(wanted);
  const sameMark = openings
    .filter((o) => openingMarkCode(codeOf(o)) === mark)
    .sort((a, b) => {
      const done = (o: T) => (o.status === "installed" ? 1 : 0);
      return (
        done(a) - done(b) ||
        codeOf(a).localeCompare(codeOf(b), undefined, { numeric: true })
      );
    });

  return sameMark.length > 0 ? { opening: sameMark[0], exact: false } : null;
}
