import type { WorkCommand } from "../customWork/model";
import type { UnitDetailsWrite } from "../install/unitDetails";
import type { ProjectOpening } from "../install/types";

/**
 * Units created on the phone that Forge has not saved yet.
 *
 * A unit someone cannot find can be created with no signal and clocked on at
 * once (Matt, 2026-11-20: "we should let them clock on a unit they can't
 * find… we don't want to lose the clock record"). Its creation waits in the
 * work queue, ahead of the timer that was started on it, so the two reach
 * Forge in order. Until then the unit exists only in that queue; these
 * functions read it back so the screens can show it like any other unit.
 */
export function queuedUnitWrites(queue: readonly WorkCommand[], projectId: string): UnitDetailsWrite[] {
  return queue.flatMap(command => {
    if (command.action !== "unit_create" || command.error) return [];
    const write = command.data as unknown as UnitDetailsWrite;
    return write.projectId === projectId ? [write] : [];
  });
}

/** The job's units with the ones still waiting on the phone added at the end. */
export function withQueuedUnits(rows: ProjectOpening[], queue: readonly WorkCommand[], projectId: string): ProjectOpening[] {
  const waiting = queuedUnitWrites(queue, projectId).filter(write => !rows.some(row => row.id === write.id));
  if (!waiting.length) return rows;
  return [...rows, ...waiting.map(write => ({
    id: write.id, project_id: write.projectId, opening_code: write.code, unit_details: write.details,
    status: "planned", window_type_id: null, window_types: null, assigned_window_id: null,
    confirmed: false, removed_at: null,
  } as unknown as ProjectOpening))];
}

/** True when the job already has a unit with this number, saved or waiting. */
export function unitNumberTaken(rows: readonly Pick<ProjectOpening, "id" | "opening_code">[], code: string, exceptId?: string): boolean {
  const wanted = code.trim().toLowerCase();
  return rows.some(row => row.id !== exceptId && row.opening_code.trim().toLowerCase() === wanted);
}

/** What a work unit is called once Forge has refused to create its unit. */
export const UNIT_NOT_CREATED = "unit not created";
