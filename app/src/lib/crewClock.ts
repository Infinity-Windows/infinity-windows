// Clocking the crew in and out from the roster — the pure half.
//
// WHY THIS FILE EXISTS (owner ask, 2026-09-04): he opened Team timecards and
// found fourteen people clocked into OFFICE a minute apart, because somebody
// had punched fourteen phones in by hand. The screen now has checkboxes and a
// bulk action, and the rules that decide WHO a tap actually touches — and what
// each answer means in plain English — live here rather than inside the page,
// so they can be tested without mounting a foreman-only screen that fetches a
// roster, the projects, the cost codes, the overtime rules and the settings.
//
// Kept free of Supabase and React on purpose (the same reasoning as
// clockCostCodes.ts and timecardNotice.ts). The RPC wrappers live in
// timeclock.ts; the sheet that calls them lives in components/timecard.

/** One row of the roster, as far as a bulk clock action cares. */
export interface CrewClockMember {
  id: string;
  name: string;
  /** On the clock right now — an open punch, whether or not it names a job. */
  onClock: boolean;
  /** The job of that open punch, or null (off the clock, or on with no job). */
  openProjectId: string | null;
}

/** Every outcome the server can answer with, as a code the UI can switch on. */
export type CrewClockOutcomeKind =
  | "clocked_in"
  | "already_on_this_job"
  | "moved_from_other_job"
  | "clocked_out"
  | "already_out"
  | "refused"
  | "unknown";

const KNOWN_OUTCOMES = new Set<CrewClockOutcomeKind>([
  "clocked_in",
  "already_on_this_job",
  "moved_from_other_job",
  "clocked_out",
  "already_out",
]);

/**
 * The server's outcome string → a code. Anything unrecognised reads as
 * "unknown" rather than being shown raw: a supervisor should never be handed a
 * word out of a database column and left to guess what it meant.
 */
export function outcomeKind(outcome: string | null | undefined): CrewClockOutcomeKind {
  const raw = (outcome ?? "").trim();
  if (raw.startsWith("refused:")) return "refused";
  return KNOWN_OUTCOMES.has(raw as CrewClockOutcomeKind)
    ? (raw as CrewClockOutcomeKind)
    : "unknown";
}

/** The plain sentence behind a `refused:…`, or "" for any other outcome. */
export function refusalReason(outcome: string | null | undefined): string {
  const raw = (outcome ?? "").trim();
  if (!raw.startsWith("refused:")) return "";
  return raw.slice("refused:".length).trim();
}

/** Who a clock-in would touch, and who it would leave alone. */
export interface CrewClockInPlan {
  /** Sent to the server: everyone selected who isn't being deliberately skipped. */
  willClockIn: string[];
  /** Selected and already on this exact job — sent anyway, and reported as such. */
  alreadyHere: string[];
  /** Selected but on a DIFFERENT job. Skipped unless "move them" is ticked. */
  elsewhere: string[];
}

/**
 * Split a selection against the job it is about to be clocked into.
 *
 * `move` off (the default) means somebody already working another job is left
 * exactly where they are and named in the skip list, because a supervisor
 * ticking fourteen boxes cannot be assumed to know that one of them started on
 * a different site an hour ago. The server holds the same line — it refuses a
 * move it was not asked for — so the honest answer survives the gap between
 * reading this roster and tapping the button.
 *
 * Order follows the roster it was given, so the skip list reads in the order
 * the names are on screen.
 */
export function planCrewClockIn(
  members: readonly CrewClockMember[],
  selectedIds: readonly string[],
  targetProjectId: string | null,
  move: boolean,
): CrewClockInPlan {
  const picked = new Set(selectedIds);
  const plan: CrewClockInPlan = { willClockIn: [], alreadyHere: [], elsewhere: [] };
  for (const m of members) {
    if (!picked.has(m.id)) continue;
    const here =
      m.onClock && targetProjectId !== null && m.openProjectId === targetProjectId;
    const away = m.onClock && !here;
    if (here) plan.alreadyHere.push(m.id);
    if (away) {
      plan.elsewhere.push(m.id);
      if (!move) continue;
    }
    plan.willClockIn.push(m.id);
  }
  return plan;
}

/**
 * Who a "clock out" would actually end. Everybody else in the selection is
 * already off, so the confirm sheet can say how many people it is really about
 * instead of how many boxes are ticked.
 */
export function crewToClockOut(
  members: readonly CrewClockMember[],
  selectedIds: readonly string[],
): string[] {
  const picked = new Set(selectedIds);
  return members.filter((m) => picked.has(m.id) && m.onClock).map((m) => m.id);
}

/** Everyone on the roster, in roster order. */
export function allCrewIds(members: readonly CrewClockMember[]): string[] {
  return members.map((m) => m.id);
}

/** Everyone with an open punch right now, in roster order. */
export function onClockCrewIds(members: readonly CrewClockMember[]): string[] {
  return members.filter((m) => m.onClock).map((m) => m.id);
}

/** Tick / untick one row, keeping the list stable and free of duplicates. */
export function toggleCrewId(selected: readonly string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter((s) => s !== id)
    : [...selected, id];
}

/**
 * "7:03 AM" from an ISO timestamp, in the reader's own local time.
 *
 * Written out rather than handed to toLocaleTimeString because this string
 * goes into a PUSH BODY, and a push has to read the same on every phone in the
 * company — a device set to a 24-hour locale would otherwise tell one crew
 * member "17:03" about the identical event. Returns "" for anything that is
 * not a real timestamp, and the caller drops the clause rather than printing
 * "Invalid Date" at somebody.
 */
export function clockTimeLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const h24 = d.getHours();
  const suffix = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, "0")} ${suffix}`;
}

/**
 * "Marlene clocked you in at OFFICE, 7:03 AM."
 *
 * ENGLISH by design, the program's rule for push copy: the operating system
 * renders a notification long before the app's language layer gets a say. The
 * durable half of this — the line in the notifications feed — comes from the
 * time_shift_edits row the server writes, so a swiped-away push loses nothing.
 */
export function clockedInPushBody(
  byName: string,
  jobLabel: string | null,
  atIso: string | null | undefined,
): string {
  const who = byName.trim() || "A supervisor";
  const where = (jobLabel ?? "").trim();
  const when = clockTimeLabel(atIso);
  const lead = where ? `${who} clocked you in at ${where}` : `${who} clocked you in`;
  return when ? `${lead}, ${when}.` : `${lead}.`;
}

/** "Marlene clocked you out, 4:30 PM." Same rules as above. */
export function clockedOutPushBody(
  byName: string,
  atIso: string | null | undefined,
): string {
  const who = byName.trim() || "A supervisor";
  const when = clockTimeLabel(atIso);
  return when ? `${who} clocked you out, ${when}.` : `${who} clocked you out.`;
}

/** How many people each kind of answer covered — the one-line summary. */
export function countCrewOutcomes(
  results: readonly { outcome: string }[],
): Record<CrewClockOutcomeKind, number> {
  const counts: Record<CrewClockOutcomeKind, number> = {
    clocked_in: 0,
    already_on_this_job: 0,
    moved_from_other_job: 0,
    clocked_out: 0,
    already_out: 0,
    refused: 0,
    unknown: 0,
  };
  for (const r of results) counts[outcomeKind(r.outcome)] += 1;
  return counts;
}

/** The people a push is worth sending to: the ones something actually happened to. */
export function actuallyChanged(
  results: readonly { profile_id: string; outcome: string }[],
): string[] {
  return results
    .filter((r) => {
      const kind = outcomeKind(r.outcome);
      return (
        kind === "clocked_in" ||
        kind === "moved_from_other_job" ||
        kind === "clocked_out"
      );
    })
    .map((r) => r.profile_id);
}
