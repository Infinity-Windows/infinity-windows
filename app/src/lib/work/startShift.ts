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

import { isNetworkError } from "../offline/outbox-core";
import { enqueueClockIn, pendingRefForShift } from "../offline/outbox";
import { clockIn, type ClockPunch, type CostCode, type TimeShift } from "../timeclock";
import type { GeoFix } from "../geo";
import type { JobMode } from "../jobModes";
import type { Project } from "../types";

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

/** Clock in now, or — with no signal — save the punch on the phone. */
export async function startShiftOrQueue(i: StartShiftInput): Promise<StartShiftResult> {
  try {
    const shift = await clockIn(i.projectId, i.costCodeId, i.geo, i.note, i.mode, i.punch);
    return { queued: false, shift };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    // The same punch and mode the live try carried: that try may already be
    // saved, and a resend of this id is answered with the shift it made.
    const entryId = await enqueueClockIn({
      projectId: i.projectId,
      costCodeId: i.costCodeId,
      lat: i.geo.lat ?? null,
      lng: i.geo.lng ?? null,
      note: i.note,
      mode: i.mode,
      punch: i.punch,
    });
    return { queued: true, shift: synthesizeQueuedShift(entryId, i, i.punch.tappedAt) };
  }
}
