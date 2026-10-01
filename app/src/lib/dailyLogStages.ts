// Horizon parity, window work (owner request 2026-10-01): the vocabulary
// for "what did the crew work on today?" and the rest of the Log Today
// form's structured chips. Pure and framework-free — file_daily_log
// validates the exact same lists server-side (20261062000000), so a stage
// this module doesn't know is refused before it reaches the database.
//
// Solar-to-window substitution, as the brief gave it: Horizon's stages
// (Racking/Modules/Wire managed/Brick & TPO/Equipment/Conduit/AC wire/
// Commissioning/Site clean) become the window install sequence below. Two
// of Horizon's three non-stage chips (Corrections, Material run) port
// unchanged — plain crew vocabulary, not solar-specific. Its third
// (Pass-through, a solar inspection handoff) has no confirmed window
// equivalent yet and is deliberately left out rather than guessed at — see
// HANDOFF.md.

export const WORK_STAGE_KEYS = [
  "prep",
  "flashing",
  "frames",
  "glass",
  "doors",
  "hardware",
  "sealing",
  "qc",
  "site_clean",
] as const;
export type WorkStageKey = (typeof WORK_STAGE_KEYS)[number];

/** Chips in the same "what did the crew work on" multiselect that are not a
 * stage — picking one never reveals a cumulative-progress slider. */
export const NON_STAGE_WORK_KEYS = ["corrections", "material_run"] as const;
export type NonStageWorkKey = (typeof NON_STAGE_WORK_KEYS)[number];

export type WorkChipKey = WorkStageKey | NonStageWorkKey;

export function isWorkStageKey(key: string): key is WorkStageKey {
  return (WORK_STAGE_KEYS as readonly string[]).includes(key);
}

export const COVERS_OPTIONS = ["windows", "doors", "both"] as const;
export type Covers = (typeof COVERS_OPTIONS)[number];

/** "Did anything stop work for 30 minutes or more?" — the first thing the
 * crew picks, matching Horizon's own cause chips 1:1 (HORIZON-REFERENCE.md):
 * Material/Weather/Equipment/Access/Other, plus Nothing (a UI-only sentinel —
 * tapping it clears every delay card; it is never itself a stored cause).
 * Picking a cause EXPANDS that cause's own amber card (description, how
 * long, Happened/Still going, attribution) — this is the selector for WHICH
 * card is open, distinct from attribution (WHO caused it) below. */
export const DELAY_CAUSES = ["material", "weather", "equipment", "access", "other"] as const;
export type DelayCause = (typeof DELAY_CAUSES)[number];

/** Horizon's attribution chips (1st Light/Horizon/Weather/Other), ported as
 * Builder/Forge/Weather/Other (HORIZON-REFERENCE.md) — WHO the delay is
 * attributed to, a separate question from the cause chip that opened the
 * card. A weather-CAUSED delay can still be attributed to "other" if, say,
 * the crew thinks the schedule itself should have allowed for it. */
export const DELAY_ATTRIBUTIONS = ["builder", "forge", "weather", "other"] as const;
export type DelayAttribution = (typeof DELAY_ATTRIBUTIONS)[number];

export const DELAY_STATUSES = ["happened", "still_going"] as const;
export type DelayStatus = (typeof DELAY_STATUSES)[number];

/**
 * One delay card — one per CAUSE the crew picked (never two cards for the
 * same cause; picking an already-open cause closes it instead). Horizon
 * supports MULTIPLE causes per day, each its own card (description, how
 * long, Happened/Still going, attribution); a single cause object does not
 * match what was observed and is not what this type carries. Never read by
 * payroll/clock code — a delay entry is a crew account of the day, not a
 * timecard edit.
 */
export interface DelayEntry {
  cause: DelayCause;
  description: string;
  minutes: number | null;
  status: DelayStatus;
  attribution: DelayAttribution;
}

export const WEATHER_IMPACT_OPTIONS = ["slowed", "stopped", "none"] as const;
export type WeatherImpact = (typeof WEATHER_IMPACT_OPTIONS)[number];

export const MISSING_ITEM_KINDS = ["material", "equipment"] as const;
export type MissingItemKind = (typeof MISSING_ITEM_KINDS)[number];

export const SAFETY_STATUS_OPTIONS = ["none_reported", "reported"] as const;
export type SafetyStatus = (typeof SAFETY_STATUS_OPTIONS)[number];

export interface MissingItem {
  description: string;
  kind: MissingItemKind;
}

/** A log's cumulative progress per real stage, 0-100 integers. Keys outside
 * WORK_STAGE_KEYS never appear — the non-stage chips carry no progress. */
export type StageProgress = Partial<Record<WorkStageKey, number>>;

/** Every structured field this wave adds to the shared daily log row, in the
 * client's shape (camelCase, nullable where "not answered" must read as
 * "not reported" rather than a zero or an empty default). One definition,
 * reused by DailyLog, FileDailyLogInput, QueuedDailyLog/MergedDailyLog and
 * ManualDailyLogFields so the thirteen fields can't drift between them. */
export interface DailyLogProgressFields {
  workStages: WorkChipKey[];
  stageProgress: StageProgress;
  covers: Covers | null;
  delays: DelayEntry[];
  safetyStatus: SafetyStatus | null;
  weatherImpact: WeatherImpact | null;
  missingTomorrow: MissingItem[];
  tomorrowStages: WorkStageKey[];
  tomorrowCrewExpected: number | null;
  tomorrowPlan: string | null;
  unitsToday: number | null;
  unitsToDate: number | null;
  unitsRemaining: number | null;
  unitsRemainingDetail: string | null;
}

export function emptyProgressFields(): DailyLogProgressFields {
  return {
    workStages: [],
    stageProgress: {},
    covers: null,
    delays: [],
    safetyStatus: null,
    weatherImpact: null,
    missingTomorrow: [],
    tomorrowStages: [],
    tomorrowCrewExpected: null,
    tomorrowPlan: null,
    unitsToday: null,
    unitsToDate: null,
    unitsRemaining: null,
    unitsRemainingDetail: null,
  };
}

/** Clamp to a whole 0-100 — the shape the slider and the server both want. */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * "was N% · +N today" (or "-N today") for one stage, read against the
 * PROJECT's previous log (not this one). Horizon shows SIGNED deltas when a
 * cumulative reading is corrected downward (observed -15/-11 today cards) —
 * this does too; it never clamps a correction to "no change". `was: null`
 * means no earlier log ever reported this stage — a genuine first reading,
 * which must read as "first reading", never as "+N today" against an
 * invented 0 baseline.
 */
export function stageProgressCaption(
  previousValue: number | null,
  current: number,
): { was: number | null; deltaToday: number | null } {
  if (previousValue === null) return { was: null, deltaToday: null };
  const was = clampPercent(previousValue);
  return { was, deltaToday: clampPercent(current) - was };
}

/** The most recent log in a project's history (any order) that actually
 * reported a value for this stage — "previous" skips days nobody touched
 * it, so a stage worked Monday and again Thursday still shows Monday's
 * cumulative reading as "was", not 0. `logs` must be the SAME job's logs;
 * callers pass the ones strictly before the day being edited. `null` means
 * no earlier log ever reported this stage — distinct from a confirmed 0. */
export function previousStageValue(
  logsBeforeToday: { stageProgress: StageProgress | null | undefined; logDate: string }[],
  stage: WorkStageKey,
): number | null {
  const sorted = [...logsBeforeToday].sort((a, b) => b.logDate.localeCompare(a.logDate));
  for (const log of sorted) {
    const v = log.stageProgress?.[stage];
    if (typeof v === "number") return clampPercent(v);
  }
  return null;
}

export interface UnitSnapshot {
  logDate: string;
  unitsToday: number | null;
  unitsToDate: number | null;
  unitsRemaining: number | null;
  unitsRemainingDetail: string | null;
}

/**
 * The latest REPORTED unit snapshot for a job, newest-first — "today" if
 * today's log reported it, otherwise the most recent earlier day that did.
 * Never averages or sums across days (the brief's own warning: repeated
 * cumulative snapshots are not additive). A day with no counts reported at
 * all is skipped entirely rather than read as zero. `todayIso` is the
 * caller's own local day (lib/dailyLogDay.ts's localDateISO()) — this
 * module stays framework-free and never reads the clock itself.
 */
export function latestUnitSnapshot<T extends UnitSnapshot>(
  logs: T[],
  todayIso: string,
): { snapshot: T; isToday: boolean } | null {
  const reported = logs.filter(
    (l) => l.unitsToday !== null || l.unitsToDate !== null || l.unitsRemaining !== null,
  );
  if (reported.length === 0) return null;
  const sorted = [...reported].sort((a, b) => b.logDate.localeCompare(a.logDate));
  const newest = sorted[0];
  return { snapshot: newest, isToday: newest.logDate === todayIso };
}
