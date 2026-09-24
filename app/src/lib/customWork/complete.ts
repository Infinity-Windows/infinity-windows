import type { WorkSession, WorkUnit } from "./model";

// "Unit complete" as ONE tap. Crews reported on 2026-09-24 that marking units
// complete "doesn't work or save", and the database agreed: of every custom
// unit ever recorded, none had stayed "whole install complete". The only way
// there was a select folded inside the unit form's optional section, and the
// form's big button, "Save and start", saved the Yes and then started a new
// visit — and a new visit reopens completion by design (custom_work_command
// 'start', "A later visit reopens completion"). So the tap undid itself.
//
// Completing is now two ordinary queued commands, in this order: stop the
// running session as "finished", then save the unit's facts with
// installation_complete = "Yes". Both go through the same offline queue as
// every other work change, so a phone with no signal keeps them and sends
// them later; nothing new is asked of the server.

/** True once the whole install is recorded as done (all visits). */
export function isUnitComplete(unit: Pick<WorkUnit, "facts">): boolean {
  return unit.facts.installation_complete === "Yes";
}

/** The server lets only the unit's author or a foreman change its details
 * ('unit' in custom_work_command: "Only the author or a foreman can edit this
 * unit."), so only they are offered the whole-install mark. Everyone else
 * finishes their own part. */
export function canEditUnit(
  unit: Pick<WorkUnit, "created_by">,
  user: string | null,
  lead: boolean,
): boolean {
  return lead || (!!user && unit.created_by === user);
}

/** The stop that ends the running session as finished. */
export function finishedStop(
  active: Pick<WorkSession, "id" | "description">,
  at: string,
  finishNote: string,
  delay: string,
): Record<string, unknown> {
  return {
    expected_session_id: active.id,
    at,
    outcome: "finished",
    finish_note: finishNote || active.description,
    delay_reason: delay,
  };
}

/** The unit save that records the whole install as complete. Job and map unit
 * stay exactly as they are, so the server asks for no assignment reason, and
 * the revision is the one this phone last saw (queued changes included). */
export function markCompleteUnit(unit: WorkUnit): Record<string, unknown> {
  return {
    id: unit.id,
    revision: unit.revision,
    project_id: unit.project_id,
    opening_id: unit.opening_id,
    label: unit.label,
    type_label: unit.type_label,
    facts: { ...unit.facts, installation_complete: "Yes" },
    reason: "",
  };
}
