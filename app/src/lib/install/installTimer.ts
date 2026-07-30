/**
 * When the install clock is allowed to run, and what number it is allowed to
 * record.
 *
 * This exists because of a real complaint: opening a window's spec sheet
 * started an "INSTALLING — 1 min" timer on a screen that was at the same time
 * showing "Not on the clock yet — clock in to start this task". The timer was
 * measuring from the moment the page mounted, so simply reading a door's specs
 * accrued install minutes.
 *
 * That number is not decoration. It is submitted as `install_events.minutes`,
 * compared against the type's par time, and a beat-par comparison awards the
 * `par` point category (see lib/points.ts) which feeds the bonus system. Time
 * measured while nobody was installing anything inflates pay-relevant figures.
 *
 * The model here is deliberately narrow:
 *
 *   Eligibility gates STARTING the clock, not the accrual afterwards.
 *
 * The server's `start_opening_work` refuses to stamp `work_started_at` unless
 * the caller has an open shift AND has signed today's toolbox talk, so a
 * non-null start time is itself proof the person was genuinely on the clock at
 * the moment work began. Once that has happened, elapsed time is elapsed time
 * and a refresh, a backgrounded phone or a lost signal must not lose it. What
 * we refuse to do is invent a start time from a page load.
 */

/** What the two server-side gates currently say about this person. */
export interface ClockEligibilityInput {
  /** They have an open shift — punched in and not yet punched out. */
  clockedIn: boolean;
  /** They have signed today's toolbox talk. */
  toolboxSigned: boolean;
  /**
   * Both answers are actually back from the server. Until they are we say
   * "unknown" rather than guessing, because guessing "blocked" flashes a
   * scary red banner on every page load and guessing "eligible" is how the
   * original bug shipped.
   */
  resolved: boolean;
}

export type EligibilityStatus = "unknown" | "blocked" | "eligible";

export interface ClockEligibility {
  status: EligibilityStatus;
  /** What to do about it, in the order it has to be done. */
  blockers: string[];
}

export const CLOCK_IN_BLOCKER = "You're not clocked in yet.";
export const TOOLBOX_BLOCKER = "Today's toolbox talk isn't signed yet.";

/**
 * The single answer to "may this person be on a task right now". Both the
 * "Not on the clock yet" banner and the install timer read this one value, so
 * the screen cannot tell someone they can't start while also counting.
 */
export function clockEligibility(input: ClockEligibilityInput): ClockEligibility {
  if (!input.resolved) return { status: "unknown", blockers: [] };

  const blockers: string[] = [];
  if (!input.clockedIn) blockers.push(CLOCK_IN_BLOCKER);
  if (!input.toolboxSigned) blockers.push(TOOLBOX_BLOCKER);

  return blockers.length > 0
    ? { status: "blocked", blockers }
    : { status: "eligible", blockers: [] };
}

/**
 * An auto-timed figure stops being believable long before this, but a phone
 * left in a pocket on the install screen overnight would otherwise write
 * hundreds of minutes into a pay-relevant field. Past the cap we stop filling
 * the number in and ask for it, rather than recording a confident lie. A real
 * install does not outlast the shift it started in.
 */
export const AUTO_TIMER_CAP_MINUTES = 8 * 60;

export type InstallTimerStatus =
  /** Not started, and they can't start yet — clock in / sign the talk. */
  | "blocked"
  /** Not started, and they may start whenever they actually begin. */
  | "idle"
  /** Genuinely started; the number is live. */
  | "running"
  /** Ran so long the auto figure can't be trusted — ask for the real one. */
  | "stale"
  /** Still settling; show nothing rather than something wrong. */
  | "unknown";

export interface InstallTimerInput {
  eligibility: EligibilityStatus;
  /**
   * When work genuinely began: the server's `work_started_at` where we have
   * it, otherwise a device-local start recorded when they tapped Start. Null
   * means nobody has started, which is the whole point.
   */
  startedAt: string | null;
  now: number;
}

export interface InstallTimerView {
  status: InstallTimerStatus;
  /**
   * Whole minutes to show and to record, or null when there is nothing
   * truthful to say. Null must never be silently turned into 0 — an
   * un-started install has no duration, it does not have a duration of zero.
   */
  minutes: number | null;
}

/** Whole minutes between a start stamp and now. Null if there is no start. */
export function elapsedMinutes(startedAt: string | null, now: number): number | null {
  if (!startedAt) return null;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return null;
  // Clock skew between a phone and the server can put the stamp in the future;
  // that is a zero-length install, never a negative one.
  return Math.max(0, Math.round((now - started) / 60000));
}

/** The whole timer state machine. */
export function installTimer(input: InstallTimerInput): InstallTimerView {
  const minutes = elapsedMinutes(input.startedAt, input.now);

  if (minutes == null) {
    // Nothing has started, so what matters is whether they *could* start.
    if (input.eligibility === "unknown") return { status: "unknown", minutes: null };
    if (input.eligibility === "blocked") return { status: "blocked", minutes: null };
    return { status: "idle", minutes: null };
  }

  // Work was started, which the server only permits on the clock. Losing that
  // elapsed time to a refresh or a clock-out would be its own bug.
  if (minutes > AUTO_TIMER_CAP_MINUTES) return { status: "stale", minutes: null };
  return { status: "running", minutes };
}

/**
 * Has a start stamp outlasted the point where the time since it is evidence of
 * anyone installing anything?
 *
 * `installTimer` already answers this for the installer's own screen, but it
 * needs to know about the clock-in gate, which the office screens have no
 * business asking about. This is the same verdict without that: given a start
 * stamp, is the elapsed time still worth putting in front of a person as a
 * duration?
 *
 * The office needs it because nothing on the server ever retires a stamp. An
 * install begun and never submitted stays "in progress" for ever, and Heartbeat
 * was reading those stamps straight into a live counter — which is how the
 * Live crew list came to show 325 hours against a window nobody had touched
 * since July. The stamp is still worth showing; the stopwatch is not.
 */
export function isStaleStart(startedAt: string | null, now: number): boolean {
  const minutes = elapsedMinutes(startedAt, now);
  return minutes != null && minutes > AUTO_TIMER_CAP_MINUTES;
}

/**
 * Is this window genuinely being installed right now?
 *
 * Every screen that wanted to know used to read `work_started_at` on its own,
 * so a single forgotten tap made a window "in progress" for ever — and being
 * "in progress" is not just a label. My Work pins that window to the top as
 * Continue and drops it out of the queue, Home shows it instead of your next
 * window, and Ask tells you you're mid-install. One stale stamp therefore stood
 * between somebody and the work they were actually meant to be doing.
 *
 * Heartbeat deliberately does NOT use this: the office is the one place a stamp
 * nobody finished should still appear, flagged, so a person can settle it.
 */
export function isInstallInProgress(
  opening: { work_started_at: string | null; status?: string | null },
  now: number = Date.now(),
): boolean {
  if (opening.status === "installed") return false;
  return (
    opening.work_started_at != null && !isStaleStart(opening.work_started_at, now)
  );
}

/** May they tap "Start install" right now? */
export function canStartInstall(eligibility: EligibilityStatus): boolean {
  return eligibility === "eligible";
}

/**
 * The number that actually gets submitted.
 *
 * A hand-typed figure always wins — the installer standing at the window knows
 * better than the clock, and overriding is a supported action, not a fallback.
 * Otherwise we submit only what we genuinely timed, and null when we timed
 * nothing.
 */
export function recordedMinutes(input: {
  touched: boolean;
  manual: string;
  timer: InstallTimerView;
}): number | null {
  if (input.touched) {
    const n = Number(input.manual);
    return input.manual.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
  }
  return input.timer.minutes;
}

/**
 * Did the server refuse because of the clock-in / toolbox gate, as opposed to
 * the phone simply having no signal?
 *
 * The difference decides whether we tell someone to go clock in, or let them
 * work offline: `start_opening_work` raises a plain message for the gate, and
 * a network failure is not a verdict on their eligibility.
 */
export function isClockGateError(err: unknown): boolean {
  const msg = String((err as { message?: string } | null)?.message ?? err ?? "");
  return /clock in|toolbox/i.test(msg);
}

/**
 * Which start stamp to trust. The server's is authoritative and survives a
 * reinstall, a new phone and a refresh; the device-local one only exists when
 * work began in a dead zone and is the best we have until the outbox drains.
 */
export function resolveStartedAt(
  serverStartedAt: string | null | undefined,
  localStartedAt: string | null | undefined,
): string | null {
  return serverStartedAt ?? localStartedAt ?? null;
}
