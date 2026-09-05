// "Log today for <job>?" — offered once, when the day is actually over.
//
// WHY CLOCK-OUT AND NOT A REMINDER. The daily log has to be written by
// somebody who was there, about a day that has finished. Clock-out is the one
// moment the app knows both of those are true, and it is the moment a foreman
// is still holding the phone. Horizon reaches the same conclusion from the
// other end: its composer is opened by a post-clock-out "log ready" toast
// through a global event host, not only by its Capture button.
//
// FOUR RULES, AND EACH ONE IS A WAY THIS COULD GO WRONG.
//
//   * It never blocks clocking out. The punch is already done and refreshed
//     before this is dispatched; nothing here can fail a clock-out.
//   * Foreman and above only. An installer cannot read a daily log at all
//     (Q7, RLS), so offering them one would be an offer that leads nowhere.
//   * Once per job per day. A foreman who clocks in and out of the same job
//     three times gets asked once. A nudge that comes back every time is a
//     nudge people learn to dismiss without reading.
//   * Dismissible, and dismissing counts. Saying no is an answer.
//
// The memory is per-device, which is the honest scope: it exists to stop THIS
// phone asking THIS person again today, not to coordinate anything.

/** Fired after a clock-out that actually reached (or was queued for) the
 *  server, carrying the job it was on. */
export const CLOCKED_OUT_EVENT = "infinity:clocked-out";

export interface ClockedOutDetail {
  projectId: string | null;
}

/** Tell whoever is listening that a shift just ended on this job. */
export function announceClockedOut(projectId: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ClockedOutDetail>(CLOCKED_OUT_EVENT, { detail: { projectId } }),
  );
}

const KEY = "infinity.dailyLogNudge.asked";

interface AskedRecord {
  /** The local day these ids belong to; a new day clears the whole record. */
  day: string;
  projectIds: string[];
}

function read(): AskedRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AskedRecord;
    if (typeof parsed?.day !== "string" || !Array.isArray(parsed?.projectIds)) return null;
    return parsed;
  } catch {
    // A private window, a locked-down browser, or JSON somebody else wrote.
    // Forgetting means asking once more, which is the harmless direction.
    return null;
  }
}

/** Has this phone already offered a log for this job today? */
export function alreadyAskedToday(projectId: string, today: string): boolean {
  const rec = read();
  return rec != null && rec.day === today && rec.projectIds.includes(projectId);
}

/** Remember that it asked, so it does not ask again until tomorrow. */
export function rememberAskedToday(projectId: string, today: string): void {
  try {
    const rec = read();
    // A record from another day is replaced whole rather than appended to:
    // yesterday's answers say nothing about today, and this keeps the stored
    // value from growing without bound on a phone nobody ever clears.
    const next: AskedRecord =
      rec && rec.day === today
        ? { day: today, projectIds: [...new Set([...rec.projectIds, projectId])] }
        : { day: today, projectIds: [projectId] };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* a device that cannot remember asks once more; nothing breaks */
  }
}
