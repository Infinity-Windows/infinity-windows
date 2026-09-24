// The one clock-in path Start day uses (crew redesign K1.3, 2026-09-23):
// the same `clockIn` RPC call every other clock-in makes, and the same
// offline outbox fallback the clock sheet has had since the outbox shipped.
// Deliberately thin — Release 0 (clock integrity) adds a client id and the
// tap time to `clockIn` and `enqueueClockIn`; Start day inherits both the
// moment that merges, because it never forks the punch.

import { isNetworkError } from "../offline/outbox-core";
import { enqueueClockIn, pendingRefForShift } from "../offline/outbox";
import { clockIn, type CostCode, type TimeShift } from "../timeclock";
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
 */
export function synthesizeQueuedShift(
  entryId: string,
  i: Pick<StartShiftInput, "profileId" | "projectId" | "costCodeId" | "note" | "projects" | "costCodes">,
  nowIso = new Date().toISOString(),
): TimeShift {
  const proj = i.projects.find((p) => p.id === i.projectId);
  const cc = i.costCodes.find((c) => c.id === i.costCodeId);
  return {
    id: pendingRefForShift(entryId),
    profile_id: i.profileId,
    project_id: i.projectId,
    cost_code_id: i.costCodeId,
    clock_in_at: nowIso,
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: nowIso,
    note: i.note,
    projects: proj ? { job_code: proj.job_code, name: proj.name } : null,
    cost_codes: cc ? { code: cc.code, label: cc.label } : null,
  } as TimeShift;
}

/** Clock in now, or — with no signal — save the punch on the phone. */
export async function startShiftOrQueue(i: StartShiftInput): Promise<StartShiftResult> {
  try {
    const shift = await clockIn(i.projectId, i.costCodeId, i.geo, i.note, i.mode);
    return { queued: false, shift };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    // The queued path carries job, cost code and note but not the mode — no
    // clock_in overload takes both p_client_id and p_mode (stated limit,
    // ClockSheet 2026-09-06). Release 0 owns closing that.
    const entryId = await enqueueClockIn({
      projectId: i.projectId,
      costCodeId: i.costCodeId,
      lat: i.geo.lat ?? null,
      lng: i.geo.lng ?? null,
      note: i.note,
    });
    return { queued: true, shift: synthesizeQueuedShift(entryId, i) };
  }
}
