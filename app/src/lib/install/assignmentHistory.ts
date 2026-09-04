// Who this unit has been handed to, and by whom (wave Y, Y5).
//
// `project_openings.assigned_to` is a single column that gets overwritten, so
// a reassignment erased the fact that anybody else ever had the unit. Every
// "why was this sitting unstarted for two days" conversation ran into that
// wall. `opening_assignment_events` is one row per change, written by a
// database trigger rather than by each of the four screens that assign — a
// screen can forget; a trigger on the column cannot.
//
// Reading is foreman+ in RLS, so an installer's own copy of this list comes
// back empty rather than refused. Degrades on a database without the table:
// no history there is the truth there, not an error screen.

import { supabase } from "../supabase";
import { isMissingTable } from "../schemaErrors";
import type { TFn } from "../i18n";

/** Which screen a hand-over came from. */
export type AssignmentVia = "dispatch" | "map" | "auto" | "unassign";

export interface OpeningAssignmentEvent {
  id: string;
  opening_id: string;
  project_id: string;
  from_profile: string | null;
  to_profile: string | null;
  changed_by: string | null;
  changed_at: string;
  via: AssignmentVia;
}

const COLS =
  "id, opening_id, project_id, from_profile, to_profile, changed_by, changed_at, via";

async function readEvents(
  build: (
    q: ReturnType<typeof supabase.from>,
  ) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<OpeningAssignmentEvent[]> {
  const { data, error } = await build(supabase.from("opening_assignment_events"));
  if (error) {
    if (isMissingTable(error, "opening_assignment_events")) return [];
    throw error;
  }
  return (data ?? []) as OpeningAssignmentEvent[];
}

/** Every hand-over of one unit, oldest first — the Record's own reading. */
export function listOpeningAssignmentEvents(
  openingId: string,
): Promise<OpeningAssignmentEvent[]> {
  return readEvents((q) =>
    q
      .select(COLS)
      .eq("opening_id", openingId)
      .order("changed_at", { ascending: true }),
  );
}

/**
 * The job's whole hand-over log, newest first and capped — the Dispatch tab
 * reads this as "who has had what". Capped rather than paged on purpose: this
 * answers "what has been happening lately", and a foreman who needs the sixth
 * page of it needs a different screen.
 */
export function listProjectAssignmentEvents(
  projectId: string,
  limit = 100,
): Promise<OpeningAssignmentEvent[]> {
  return readEvents((q) =>
    q
      .select(COLS)
      .eq("project_id", projectId)
      .order("changed_at", { ascending: false })
      .limit(limit),
  );
}

// =============================================================================
// Pure rendering
// =============================================================================

/**
 * One hand-over as a plain sentence. `nameOf` resolves profile ids; anybody
 * the roster cannot name reads as "Crew", the same fallback the session
 * timeline already uses.
 *
 * Three shapes, because three things actually happen: a unit is given out, a
 * unit moves from one person to another, and a unit comes off a list. Saying
 * all three with one template ("assigned to nobody") is how a log stops being
 * read. Each has a named and an unnamed form rather than a " by …" tail glued
 * on, because Spanish puts the person who moved it at the front of the
 * sentence.
 *
 * `t` is a parameter and not a hook so this stays pure and testable — the same
 * reason `nameOf` is one.
 */
export function assignmentText(
  event: Pick<OpeningAssignmentEvent, "from_profile" | "to_profile" | "changed_by">,
  nameOf: (profileId: string) => string | null | undefined,
  t: TFn,
): string {
  const who = (id: string | null) => (id ? nameOf(id) || t("assign.crew") : null);
  const to = who(event.to_profile);
  const from = who(event.from_profile);
  const by = who(event.changed_by);
  if (to && from) {
    return by
      ? t("assign.movedBy", { from, to, by })
      : t("assign.moved", { from, to });
  }
  if (to) return by ? t("assign.assignedBy", { to, by }) : t("assign.assigned", { to });
  if (from) {
    return by
      ? t("assign.takenOffBy", { from, by })
      : t("assign.takenOff", { from });
  }
  return by ? t("assign.clearedBy", { by }) : t("assign.cleared");
}

/** A unit's hand-overs in the shape the Record's timeline merges and sorts. */
export function assignmentTimelineRows(
  events: readonly OpeningAssignmentEvent[],
  nameOf: (profileId: string) => string | null | undefined,
  t: TFn,
): { at: string; text: string; kind: "assign" }[] {
  return events.map((e) => ({
    at: e.changed_at,
    text: assignmentText(e, nameOf, t),
    kind: "assign" as const,
  }));
}
