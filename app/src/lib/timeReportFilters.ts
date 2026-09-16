/** null means every job; an empty list deliberately means no jobs. */
export type JobSelection = readonly string[] | null;
export const NO_JOB = "unassigned";

export function includesJob(selection: JobSelection, projectId: string | null): boolean {
  return selection === null || selection.includes(projectId ?? NO_JOB);
}

/** Native date fields use local calendar days, like the existing pay periods. */
export function dateFieldValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return year >= 1000 && dateFieldValue(date) === value ? date : null;
}

export function customTimeRange(from: string, through: string):
  | { error: "missing" | "invalid" | "order" }
  | { error: null; start: Date; lastDay: Date; startIso: string; endIso: string } {
  if (!from || !through) return { error: "missing" };
  const start = parseDay(from);
  const lastDay = parseDay(through);
  if (!start || !lastDay) return { error: "invalid" };
  if (lastDay < start) return { error: "order" };
  const end = new Date(lastDay);
  // Calendar arithmetic keeps the whole last day through daylight-saving changes.
  end.setDate(end.getDate() + 1);
  return { error: null, start, lastDay, startIso: start.toISOString(), endIso: end.toISOString() };
}
