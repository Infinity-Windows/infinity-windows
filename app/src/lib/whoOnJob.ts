// Pure merge of the several places a person can be attached to a job — the
// published schedule crew, the installers dispatched to openings, and the job
// chat roster — into one deduped "who's on this job" list. Kept free of React
// and Supabase so the merge is unit-testable and the panel stays read-only.

export type JobPersonSource = "schedule" | "dispatch" | "chat";

export interface ScheduleMemberLike {
  profile_id: string;
  display_name: string | null;
  role?: string | null;
}

export interface OpeningAssigneeLike {
  id: string;
  display_name: string | null;
  role?: string | null;
}

export interface RosterMemberLike {
  id: string;
  display_name: string | null;
  role: string | null;
  /** True when the person is crew on THIS job (vs. a supervisor who can view any job). */
  assigned: boolean;
}

export interface JobPerson {
  id: string;
  name: string;
  role: string | null;
  /** Which surfaces reference this person, in a stable schedule→dispatch→chat order. */
  sources: JobPersonSource[];
}

export interface MergeJobPeopleInput {
  scheduleMembers: ScheduleMemberLike[];
  openingAssignees: OpeningAssigneeLike[];
  rosterMembers: RosterMemberLike[];
}

const SOURCE_ORDER: JobPersonSource[] = ["schedule", "dispatch", "chat"];

/**
 * Merge the schedule crew, dispatched opening assignees, and assigned chat
 * roster into one list keyed by profile id. Each person keeps the set of
 * sources that reference them; the first non-blank name/role wins. Only roster
 * members flagged `assigned` (job crew, not view-any supervisors) are included.
 */
export function mergeJobPeople(input: MergeJobPeopleInput): JobPerson[] {
  const byId = new Map<
    string,
    { id: string; name: string | null; role: string | null; sources: Set<JobPersonSource> }
  >();

  const add = (
    id: string | null | undefined,
    name: string | null,
    role: string | null,
    source: JobPersonSource,
  ) => {
    if (!id) return;
    let entry = byId.get(id);
    if (!entry) {
      entry = { id, name: null, role: null, sources: new Set() };
      byId.set(id, entry);
    }
    entry.sources.add(source);
    if (!entry.name && name) entry.name = name;
    if (!entry.role && role) entry.role = role;
  };

  for (const m of input.scheduleMembers) {
    add(m.profile_id, m.display_name, m.role ?? null, "schedule");
  }
  for (const o of input.openingAssignees) {
    add(o.id, o.display_name, o.role ?? null, "dispatch");
  }
  for (const r of input.rosterMembers) {
    if (r.assigned) add(r.id, r.display_name, r.role, "chat");
  }

  return [...byId.values()]
    .map((e) => ({
      id: e.id,
      name: e.name ?? "Crew",
      role: e.role,
      sources: SOURCE_ORDER.filter((s) => e.sources.has(s)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
