// The one clock-in path Start day uses (crew redesign K1.3, 2026-09-23):
// the same `clockIn` RPC call every other clock-in makes, and the same
// offline outbox fallback the clock sheet has had since the outbox shipped.
//
// ONE PUNCH PER TAP (Release 0, 20261028000000 — Codex review of #642,
// 2026-09-25). The caller mints the punch — the one-time id and the tap time
// — at the tap that starts the day, before the geolocation wait, and this
// hands the SAME punch and the same mode to the live try and to the queue.
// The live try can be saved by the server with its reply lost; the queue then
// sends it again, and the server answers that id with the shift it already
// made instead of a second one. Deliberately thin: it never forks the punch.

import type { Session } from "@supabase/supabase-js";
import { isNetworkError } from "../offline/outbox-core";
import { enqueueClockIn, pendingRefForShift, todaysSignatureOnPhone } from "../offline/outbox";
import { clientWithToken, supabase } from "../supabase";
import { clockIn, type ClockPunch, type CostCode, type TimeShift } from "../timeclock";
import type { GeoFix } from "../geo";
import type { JobMode } from "../jobModes";
import type { Project } from "../types";
import { signedInUserId } from "../signedIn";

/**
 * How long a live Start day waits for `getSession()` before giving up on the
 * live try and queuing the tap instead (Codex review: direct-RPC identity
 * race). `clockIn`'s ambient client awaits its own session read before it can
 * even build the Authorization header (supabase-js `_getSessionToken`), which
 * on a shared phone can straddle an account switch: A passes the sync guard
 * above, then B signs in while A's session read is still pending, and the
 * live call would go out under B's token. Reading the session HERE first,
 * then sending on a client frozen to that one token (clientWithToken), closes
 * that window — the fallback below is what a session read that never
 * resolves in time falls back to.
 */
export const SESSION_WAIT_MS = 4000;

type SessionOutcome = { ok: true; session: Session } | { ok: false };

/**
 * `getSession()`, bounded. A late reply — one that lands after the timeout —
 * is dropped on arrival: nothing here reacts to it, so a slow resolution can
 * never trigger an RPC after the caller has already moved on to the queue.
 */
function boundedSession(): Promise<SessionOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false });
    }, SESSION_WAIT_MS);
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(data.session ? { ok: true, session: data.session } : { ok: false });
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false });
      });
  });
}

export interface StartShiftInput {
  profileId: string;
  projectId: string | null;
  costCodeId: string | null;
  note: string | null;
  mode: JobMode | null;
  geo: GeoFix;
  /**
   * The tap's one punch: minted at the tap that starts the day (or at the
   * signature, when signing IS the clock-in), before the geolocation wait,
   * and handed unchanged to the live try AND the queue (see the header).
   */
  punch: ClockPunch;
  /** For the optimistic shift the phone shows while a queued punch waits. */
  projects: readonly Pick<Project, "id" | "job_code" | "name">[];
  costCodes: readonly Pick<CostCode, "id" | "code" | "label">[];
}

export interface StartShiftResult {
  /** True when the punch was saved on the phone rather than in Forge. */
  queued: boolean;
  /** The shift to show: the server's row, or a synthetic pending one. */
  shift: TimeShift;
}

/**
 * The synthetic open shift the phone shows while its clock-in waits in the
 * outbox — the same shape ClockSheet builds. Its id is the outbox entry's
 * pending ref, which is how every screen tells a queued punch from a real one.
 * It starts at the punch's TAP time, as the queued-clock view does (#644) and
 * as the server pays it when it trusts the phone — not at the moment the
 * queue happened to store it.
 */
export function synthesizeQueuedShift(
  entryId: string,
  i: Pick<StartShiftInput, "profileId" | "projectId" | "costCodeId" | "note" | "mode" | "projects" | "costCodes">,
  tappedAtIso: string,
): TimeShift {
  const proj = i.projects.find((p) => p.id === i.projectId);
  const cc = i.costCodes.find((c) => c.id === i.costCodeId);
  return {
    id: pendingRefForShift(entryId),
    profile_id: i.profileId,
    project_id: i.projectId,
    cost_code_id: i.costCodeId,
    clock_in_at: tappedAtIso,
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: tappedAtIso,
    note: i.note,
    job_mode: i.mode,
    projects: proj ? { job_code: proj.job_code, name: proj.name } : null,
    cost_codes: cc ? { code: cc.code, label: cc.label } : null,
  } as TimeShift;
}

/** The same punch and mode the live try would have carried, saved on the phone. */
async function queueStart(i: StartShiftInput): Promise<StartShiftResult> {
  const entryId = await enqueueClockIn({
    projectId: i.projectId,
    costCodeId: i.costCodeId,
    lat: i.geo.lat ?? null,
    lng: i.geo.lng ?? null,
    note: i.note,
    mode: i.mode,
    punch: i.punch,
    profileId: i.profileId,
  });
  return { queued: true, shift: synthesizeQueuedShift(entryId, i, i.punch.tappedAt) };
}

/** Clock in now, or — with no signal — save the punch on the phone. */
export async function startShiftOrQueue(i: StartShiftInput): Promise<StartShiftResult> {
  // The geolocation wait can outlive an account switch on a shared phone.
  // Never let that old tap use the new account's live token or queue owner.
  if (signedInUserId() !== i.profileId) {
    throw new Error("This clock-in belongs to another account on this phone. Sign in again before clocking in.");
  }
  // A signature still on this phone must reach Forge first. Sending this
  // clock-in live would be refused by the server gate before that dependency
  // can drain; the outbox preserves the tap's punch and owner on both writes.
  if (todaysSignatureOnPhone(i.profileId)) {
    return queueStart(i);
  }

  // Read the session ourselves, bounded, BEFORE the live try — see
  // boundedSession's header. A timeout (or an unreadable session) is treated
  // exactly like the network failure below: the tap is saved, not lost.
  const outcome = await boundedSession();
  if (!outcome.ok) {
    return queueStart(i);
  }
  const { session } = outcome;
  // The session that came back, or the account on this phone, has moved on
  // from the account that tapped Start day. Refuse outright — this tap must
  // never be sent OR queued under whoever is now signed in.
  if (session.user?.id !== i.profileId || signedInUserId() !== i.profileId) {
    throw new Error("This clock-in belongs to another account on this phone. Sign in again before clocking in.");
  }

  try {
    const shift = await clockIn(
      i.projectId,
      i.costCodeId,
      i.geo,
      i.note,
      i.mode,
      i.punch,
      clientWithToken(session.access_token),
    );
    return { queued: false, shift };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    // The same punch and mode the live try carried: that try may already be
    // saved, and a resend of this id is answered with the shift it made.
    return queueStart(i);
  }
}
