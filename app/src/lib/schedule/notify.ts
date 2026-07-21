// Pure notify-diff: decide WHO to (re)notify and WHAT the batched digest says.
// Notifications are one digest per affected person per publish ("You're
// scheduled on N jobs") — never one push per block — and edits after publish
// re-notify only the people actually affected.

export interface MemberDiff {
  added: string[];
  removed: string[];
  retained: string[];
}

/** Set diff of two member-id lists (order-independent, de-duplicated). */
export function diffMembers(
  before: readonly string[],
  after: readonly string[],
): MemberDiff {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added: string[] = [];
  const removed: string[] = [];
  const retained: string[] = [];
  for (const id of afterSet) {
    if (beforeSet.has(id)) retained.push(id);
    else added.push(id);
  }
  for (const id of beforeSet) {
    if (!afterSet.has(id)) removed.push(id);
  }
  return { added, removed, retained };
}

export interface EditNotifyInput {
  membersBefore: readonly string[];
  membersAfter: readonly string[];
  /** True when the date range or start time changed. */
  scheduleChanged: boolean;
}

/**
 * People to re-notify after editing an already-published assignment:
 * everyone added or removed, plus everyone retained IF the timing changed
 * (their schedule moved under them). No change → nobody.
 */
export function affectedByEdit(input: EditNotifyInput): string[] {
  const { added, removed, retained } = diffMembers(
    input.membersBefore,
    input.membersAfter,
  );
  const out = new Set<string>([...added, ...removed]);
  if (input.scheduleChanged) for (const id of retained) out.add(id);
  return [...out];
}

export interface DigestAssignment {
  id: string;
  status: string;
  members: { profile_id: string }[];
}

export interface PersonDigest {
  profileId: string;
  assignmentIds: string[];
}

/**
 * One digest per person across the assignments being published: the person's
 * full set of jobs so the push reads "You're scheduled on N jobs" rather than
 * one buzz per block. Only counts assignments the person is actually on.
 */
export function buildPublishDigests(
  assignments: DigestAssignment[],
): PersonDigest[] {
  const byPerson = new Map<string, string[]>();
  for (const a of assignments) {
    for (const m of a.members) {
      const list = byPerson.get(m.profile_id) ?? [];
      list.push(a.id);
      byPerson.set(m.profile_id, list);
    }
  }
  return [...byPerson.entries()].map(([profileId, assignmentIds]) => ({
    profileId,
    assignmentIds,
  }));
}

/** Push copy for a person's publish digest. */
export function digestMessage(jobCount: number): { title: string; body: string } {
  if (jobCount <= 1) {
    return {
      title: "You're scheduled",
      body: "You have a new job on your schedule. Tap to see the details.",
    };
  }
  return {
    title: "You're scheduled",
    body: `You're scheduled on ${jobCount} jobs. Tap to see your week.`,
  };
}

/** Push copy for someone removed from a published assignment. */
export function removalMessage(): { title: string; body: string } {
  return {
    title: "Schedule updated",
    body: "One of your jobs was changed or removed. Tap to check your schedule.",
  };
}
