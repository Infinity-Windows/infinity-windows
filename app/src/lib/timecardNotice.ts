// What to tell somebody whose punch a supervisor just changed (Wave K, K4).
//
// WHY THIS EXISTS (transcripts grill, 2026-09-03): the app only pushed when an
// ALREADY-APPROVED punch was edited. Every other change to somebody else's
// hours — an edit before approval, a punch added on their behalf, a deleted one
// restored — happened in silence. A person's pay changing without them hearing
// about it is the exact thing this feature is for, and "it wasn't approved yet"
// is not a reason to keep it from them.
//
// Push copy is ENGLISH by design (the program's rule): the operating system
// renders a push long before the app's language layer gets a say.
//
// Pure and tested here; ShiftEditor and PunchCard only supply the two versions
// of the punch.

/** The parts of a punch a change is worth naming. */
export interface PunchSnapshot {
  clock_in_at?: string | null;
  clock_out_at?: string | null;
  break_seconds?: number | null;
  project_id?: string | null;
  cost_code_id?: string | null;
}

/**
 * Plain names for what actually moved, in the order a person reads a punch.
 * Empty when a save changed nothing measurable (a reason typed, then Save).
 */
export function changedPunchFields(
  before: PunchSnapshot,
  after: PunchSnapshot,
): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  if (!same(before.clock_in_at, after.clock_in_at)) out.push("start time");
  if (!same(before.clock_out_at, after.clock_out_at)) out.push("finish time");
  if ((before.break_seconds ?? 0) !== (after.break_seconds ?? 0)) out.push("break");
  if (!same(before.project_id, after.project_id)) out.push("job");
  if (!same(before.cost_code_id, after.cost_code_id)) out.push("cost code");
  return out;
}

/** "start time and break" / "start time, finish time and job". */
export function joinPlainList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The push body for an edit. Names what moved when we can, and stays honest
 * ("something on your punch") rather than inventing detail when we cannot.
 */
export function editPushBody(fields: string[], wasApproved: boolean): string {
  const what = joinPlainList(fields);
  const lead = what
    ? `The ${what} on one of your punches changed.`
    : "Something on one of your punches changed.";
  return wasApproved
    ? `${lead} It needs approving again.`
    : `${lead} Check My timecard.`;
}
