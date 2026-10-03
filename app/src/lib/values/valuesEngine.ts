/**
 * Monthly core-value reviews — the pure logic.
 *
 * Ported from the pinned Horizon snapshot (`94b0d20cd0882ee1173092d2892b97a4a198d946`,
 * `src/lib/valueScores.ts`) per the owner-approved architecture brief
 * (2026-10-03, ../outputs/Horizon-Crew-Goals-Reviews-2026-10-03). Everything in
 * this file is deterministic and has no server/client split the way Horizon's
 * did — Forge is Postgres-only, so the SQL side (20261106000000) re-implements
 * the same rules independently. Keep the two in sync by hand; there is no
 * promise of bit-identical random person selection between them (the brief
 * says so explicitly), only the same RULES: quotas, the coverage floor, the
 * merge-on-redeal guarantee, and the per-value rater threshold.
 *
 * DECLARED ADAPTATIONS FROM THE PINNED SOURCE (owner-approved, 2026-10-03):
 *   1. Denver, not Eastern. `VALUES_TZ` is `America/Denver` — an explicit
 *      locale change, not literal Eastern-midnight parity. A separate fixture
 *      (valuesEngine.test.ts) checks the Eastern-source formula still lines up
 *      on the same calendar math before the timezone swap.
 *   2. Per-value rater threshold, not window-wide. Horizon's `buildMirror`
 *      counted three distinct non-self raters once across the whole window,
 *      so three raters on OTHER values could let a value with only one actual
 *      rater through. `buildMirror` below counts the threshold separately for
 *      EVERY value slug (TRANSFER-INTEGRITY-REVIEW.md §3). This is a privacy
 *      correction, not a numerical-parity break.
 *   3. No clock-in wall. Horizon's `clockInWallApplies` gated the next
 *      clock-in on owed scores and failed open when unknown. Forge does not
 *      port that function at all: a review is never allowed to block, edit or
 *      backdate paid time (owner instruction, 2026-10-03). The functions below
 *      say when a period is open and who owes what; nothing reads them to
 *      refuse a clock punch.
 *   4. Complete submissions only. Horizon wrote a submission header and its
 *      eight score children as two steps and had a repair writer for a header
 *      saved without them. `values_submit` (SQL) commits the header and all
 *      eight children in one transaction — there is no incomplete submission
 *      to aggregate, so `buildMirror`/`buildQuarterlyRating` below can assume
 *      every `ScoreRow` they are given came from a complete, accepted
 *      submission.
 *   5. No weekly history. Horizon's `isMonthPeriod`/`periodEndExclusive` carry
 *      a weekly-vs-monthly fork because Horizon is MID-MIGRATION from a real
 *      weekly ritual. Forge has never run a weekly ritual, so every period
 *      here is a calendar month and that fork is simply not ported.
 */
import type { CoreValueSlug } from "./rubric";
import { VALUE_SLUGS } from "./rubric";

/**
 * The company's own working day for this feature. An explicit Denver
 * adaptation of Horizon's America/New_York (TRANSFER-INTEGRITY-REVIEW.md §4):
 * a locale choice, not a claim that Denver and Eastern calendar days ever
 * coincide.
 */
export const VALUES_TZ = "America/Denver";

/** The Eastern/Denver calendar day a timestamp falls on, as `YYYY-MM-DD`. */
export function valuesDayOf(at: Date, timeZone: string = VALUES_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

/** The 1st of the month a (local) day falls in — the period's name. */
export function periodStartOfDay(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Shift a period by whole months: ("2026-10-01", -1) → "2026-09-01". */
export function addMonthsToPeriod(periodStart: string, months: number): string {
  const [y, m] = periodStart.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + months, 1)).toISOString().slice(0, 10);
}

/** How many days the month beginning `periodStart` has. */
export function daysInPeriod(periodStart: string): number {
  const [y, m] = periodStart.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/** The last day of the month beginning `periodStart`. */
export function periodEndOfStart(periodStart: string): string {
  return `${periodStart.slice(0, 8)}${String(daysInPeriod(periodStart)).padStart(2, "0")}`;
}

/** The first day after a stored (monthly) period. Forge has no weekly history. */
export function periodEndExclusive(periodStart: string): string {
  return addMonthsToPeriod(periodStart, 1);
}

/** Seven days, whatever weekday the month ends on — same idea Horizon used. */
export const SCORING_WINDOW_DAYS = 7;

/** The day a month's window opens. */
export function scoringWindowOpensOn(periodStart: string): string {
  const first = daysInPeriod(periodStart) - SCORING_WINDOW_DAYS + 1;
  return `${periodStart.slice(0, 8)}${String(first).padStart(2, "0")}`;
}

/** True in the month's last week. Nothing blocks on this — it only decides WHICH month is "current" below. */
export function scoringWindowOpen(at: Date): boolean {
  const day = valuesDayOf(at);
  return day >= scoringWindowOpensOn(periodStartOfDay(day));
}

/** Which month is currently being scored. */
export function activeScoringPeriodStart(at: Date): string {
  const thisMonth = periodStartOfDay(valuesDayOf(at));
  return scoringWindowOpen(at) ? thisMonth : addMonthsToPeriod(thisMonth, -1);
}

/** The most recent month that has fully ended as of `at`. */
export function lastClosedPeriodStart(at: Date): string {
  return addMonthsToPeriod(periodStartOfDay(valuesDayOf(at)), -1);
}

/**
 * The first month this build may deal or score. Adjustable before real
 * release (docs/monthly-values-reviews.md) — this build is deployment-gated,
 * so nothing here has run against live data yet.
 */
export const VALUES_MONTHLY_LAUNCH = "2026-10-01";

export function periodIsScorable(periodStart: string): boolean {
  return periodStart >= VALUES_MONTHLY_LAUNCH;
}

/** "October" / "Oct" — how a stored period reads to a person. */
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function periodLabel(periodStart: string, opts: { short?: boolean } = {}): string {
  const [, m] = periodStart.split("-").map(Number);
  const month = MONTH_NAMES[m! - 1]!;
  return opts.short ? month.slice(0, 3) : month;
}

// ---------------------------------------------------------------------------
// The deal
// ---------------------------------------------------------------------------

export type PersonDay = { userId: string; projectId: string; day: string };

export type DealInput = {
  periodStart: string;
  /** Distinct (person, project, local day) rows for the month. */
  personDays: PersonDay[];
  leadIds: ReadonlySet<string>;
  ownerIds: ReadonlySet<string>;
  /** Solo raters draw from here: the previous month's crew-mates per person. */
  recentCoworkers: ReadonlyMap<string, readonly string[]>;
  rng: () => number;
};

export type AssignmentReason = "dealt" | "crew" | "owner_lead" | "self" | "solo";

export type Assignment = {
  raterId: string;
  subjectId: string;
  reason: AssignmentReason;
  solo: boolean;
};

export const WORKER_QUOTA = 2;
export const COVERAGE_FLOOR = 2;

/** A deterministic rng seeded from a string — mulberry32. */
export function seededRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Deal the month's assignments. See the Horizon-parity comments in the pinned
 * source for the full rationale; the rules are unchanged:
 *   - Owners review every lead who clocked, plus (if the owner clocked too)
 *     everyone the owner personally worked beside.
 *   - Leads review everyone they worked beside, plus themselves.
 *   - Workers are dealt two coworkers (or, with none, up to two of last
 *     month's at solo/half weight), plus themselves.
 *   - A top-up pass brings everyone below the coverage floor up to it, where
 *     the crew actually makes that possible.
 */
export function dealAssignments(input: DealInput): Assignment[] {
  const { personDays, leadIds, ownerIds, recentCoworkers, rng } = input;

  const active = new Set(personDays.map((p) => p.userId));
  const byCell = new Map<string, string[]>();
  for (const p of personDays) {
    const key = `${p.projectId}|${p.day}`;
    (byCell.get(key) ?? byCell.set(key, []).get(key)!).push(p.userId);
  }
  const coworkers = new Map<string, Set<string>>();
  for (const cell of byCell.values()) {
    for (const a of cell)
      for (const b of cell) {
        if (a === b) continue;
        (coworkers.get(a) ?? coworkers.set(a, new Set()).get(a)!).add(b);
      }
  }

  const out: Assignment[] = [];
  const seen = new Set<string>();
  const add = (a: Assignment) => {
    const key = `${a.raterId}|${a.subjectId}`;
    if (a.raterId === a.subjectId && a.reason !== "self") return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a);
  };

  for (const owner of ownerIds) {
    for (const lead of leadIds) {
      if (active.has(lead)) add({ raterId: owner, subjectId: lead, reason: "owner_lead", solo: false });
    }
    for (const mate of coworkers.get(owner) ?? []) {
      add({ raterId: owner, subjectId: mate, reason: "crew", solo: false });
    }
  }

  for (const lead of leadIds) {
    if (!active.has(lead)) continue;
    for (const mate of coworkers.get(lead) ?? []) {
      add({ raterId: lead, subjectId: mate, reason: "crew", solo: false });
    }
    add({ raterId: lead, subjectId: lead, reason: "self", solo: false });
  }

  const workers = [...active].filter((u) => !leadIds.has(u) && !ownerIds.has(u)).sort();
  const outgoing = new Map<string, number>();
  const received = new Map<string, number>();
  const bumpReceived = (s: string) => received.set(s, (received.get(s) ?? 0) + 1);
  for (const a of out) if (a.reason !== "self") bumpReceived(a.subjectId);

  for (const worker of shuffled(workers, rng)) {
    const pool = [...(coworkers.get(worker) ?? [])];
    if (pool.length === 0) {
      const recent = (recentCoworkers.get(worker) ?? []).filter((u) => u !== worker);
      for (const subject of shuffled(recent, rng).slice(0, WORKER_QUOTA)) {
        add({ raterId: worker, subjectId: subject, reason: "solo", solo: true });
        bumpReceived(subject);
      }
    } else {
      const picked = shuffled(pool, rng)
        .sort((a, b) => (received.get(a) ?? 0) - (received.get(b) ?? 0))
        .slice(0, WORKER_QUOTA);
      for (const subject of picked) {
        add({ raterId: worker, subjectId: subject, reason: "dealt", solo: false });
        bumpReceived(subject);
      }
    }
    outgoing.set(worker, Math.min(WORKER_QUOTA, (coworkers.get(worker) ?? new Set()).size));
    add({ raterId: worker, subjectId: worker, reason: "self", solo: false });
  }

  const floorTargets = [...active].filter((u) => !ownerIds.has(u) && (received.get(u) ?? 0) < COVERAGE_FLOOR);
  for (const subject of shuffled(floorTargets, rng)) {
    let need = COVERAGE_FLOOR - (received.get(subject) ?? 0);
    const candidates = shuffled([...(coworkers.get(subject) ?? [])], rng)
      .filter((r) => !seen.has(`${r}|${subject}`))
      .sort((a, b) => (outgoing.get(a) ?? 0) - (outgoing.get(b) ?? 0));
    for (const rater of candidates) {
      if (need <= 0) break;
      add({ raterId: rater, subjectId: subject, reason: "dealt", solo: false });
      outgoing.set(rater, (outgoing.get(rater) ?? 0) + 1);
      bumpReceived(subject);
      need--;
    }
    // A one-person site all month simply cannot reach the floor — the owner
    // report shows the gap instead of inventing a rater.
  }

  return out;
}

/**
 * Which of a fresh deal's assignments may actually be stored, given what the
 * period already holds. See the pinned source's long comment on this
 * function (src/lib/valueScores.ts) for the full incident history — a rater
 * who already holds rows for the period is never dealt a fresh base pick
 * again, but a subject still short of the coverage floor may still collect
 * one, from ANY rater (new or not). This is what makes a re-run idempotent
 * instead of additive.
 */
export function assignmentsToStore(
  dealt: readonly Assignment[],
  stored: readonly { raterId: string; subjectId: string }[],
): Assignment[] {
  const dealtRaters = new Set(stored.map((s) => s.raterId));
  const have = new Set(stored.map((s) => `${s.raterId}|${s.subjectId}`));
  const received = new Map<string, number>();
  const bump = (subjectId: string) => received.set(subjectId, (received.get(subjectId) ?? 0) + 1);
  for (const s of stored) if (s.raterId !== s.subjectId) bump(s.subjectId);

  const out: Assignment[] = [];
  for (const a of dealt) {
    if (have.has(`${a.raterId}|${a.subjectId}`)) continue;
    const isSelf = a.raterId === a.subjectId;
    const raterIsNew = !dealtRaters.has(a.raterId);
    const subjectIsShort = !isSelf && (received.get(a.subjectId) ?? 0) < COVERAGE_FLOOR;
    if (!raterIsNew && !subjectIsShort) continue;
    out.push(a);
    if (!isSelf) bump(a.subjectId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The mirror (aggregation)
// ---------------------------------------------------------------------------

export type RaterClass = "owner" | "crew_leader" | "worker" | "self";

export type ScoreRow = {
  raterId: string;
  raterClass: RaterClass;
  solo: boolean;
  slug: CoreValueSlug;
  score: number;
};

export type ValueWeights = {
  owner: number;
  crew_leader: number;
  worker: number;
  self: number;
  soloFactor: number;
};

/** Per-value distinct non-self rater count — SAFETY FIX #2, see file header. */
export type PerValueMirror = { average: number | null; self: number | null; raters: number };

export type ValueMirror = {
  byValue: Record<CoreValueSlug, PerValueMirror>;
  /** Distinct non-self raters anywhere in the window — informational only;
   *  NEVER used to decide whether a single value's average may be shown. */
  raterCount: number;
};

export const MIRROR_MIN_RATERS = 3;

function emptyByValue(): Record<CoreValueSlug, PerValueMirror> {
  const out = {} as Record<CoreValueSlug, PerValueMirror>;
  for (const slug of VALUE_SLUGS) out[slug] = { average: null, self: null, raters: 0 };
  return out;
}

/**
 * Build a mirror from a set of COMPLETE score rows (every row here must come
 * from an atomically accepted submission — see file header, adaptation #4).
 *
 * Each value's average is suppressed independently until it has its own
 * `minRaters` distinct non-self raters — not the window's raters overall
 * (TRANSFER-INTEGRITY-REVIEW.md §3). A value's self score is a plain average
 * of self-submissions and is shown regardless, clearly labeled as self.
 */
export function buildMirror(rows: readonly ScoreRow[], weights: ValueWeights, minRaters: number = MIRROR_MIN_RATERS): ValueMirror {
  const byValue = emptyByValue();
  const bySlug = new Map<CoreValueSlug, ScoreRow[]>();
  for (const r of rows) (bySlug.get(r.slug) ?? bySlug.set(r.slug, []).get(r.slug)!).push(r);

  for (const slug of VALUE_SLUGS) {
    const list = bySlug.get(slug) ?? [];
    const selfScores = list.filter((r) => r.raterClass === "self");
    const self = selfScores.length > 0 ? selfScores.reduce((s, r) => s + r.score, 0) / selfScores.length : null;
    const raters = new Set(list.filter((r) => r.raterClass !== "self").map((r) => r.raterId)).size;
    let average: number | null = null;
    if (raters >= minRaters) {
      let num = 0;
      let den = 0;
      for (const r of list) {
        const w = weights[r.raterClass] * (r.solo ? weights.soloFactor : 1);
        num += w * r.score;
        den += w;
      }
      if (den > 0) average = num / den;
    }
    byValue[slug] = { average, self, raters };
  }

  const raterCount = new Set(rows.filter((r) => r.raterClass !== "self").map((r) => r.raterId)).size;
  return { byValue, raterCount };
}

/**
 * The window a rolling mirror actually covers, as an explicit date range —
 * never the misleading "last 3 months" label (TRANSFER-INTEGRITY-REVIEW.md
 * §4: the inclusive lower bound plus the in-progress current month can name
 * four distinct calendar months).
 */
export const MIRROR_WINDOW_MONTHS = 3;

export function mirrorWindowRange(asOf: Date): { start: string; end: string } {
  const today = periodStartOfDay(valuesDayOf(asOf));
  return { start: addMonthsToPeriod(today, -MIRROR_WINDOW_MONTHS), end: valuesDayOf(asOf) };
}

// ---------------------------------------------------------------------------
// The quarterly rating
// ---------------------------------------------------------------------------

export function quarterStartOfDay(day: string): string {
  const [y, m] = day.split("-").map(Number);
  const firstMonth = Math.floor((m! - 1) / 3) * 3 + 1;
  return `${y}-${String(firstMonth).padStart(2, "0")}-01`;
}

export function quarterEndOfStart(quarterStart: string): string {
  const [y, m] = quarterStart.split("-").map(Number);
  const end = new Date(Date.UTC(y!, m! + 2, 0));
  return end.toISOString().slice(0, 10);
}

export function previousQuarterStart(quarterStart: string): string {
  const [y, m] = quarterStart.split("-").map(Number);
  return m! === 1 ? `${y! - 1}-10-01` : `${y}-${String(m! - 3).padStart(2, "0")}-01`;
}

export function nextQuarterStart(quarterStart: string): string {
  const [y, m] = quarterStart.split("-").map(Number);
  return m! === 10 ? `${y! + 1}-01-01` : `${y}-${String(m! + 3).padStart(2, "0")}-01`;
}

export function lastClosedQuarterStart(at: Date): string {
  return previousQuarterStart(quarterStartOfDay(valuesDayOf(at)));
}

/**
 * Denver 00:00 on the 10th of the month after a quarter closes — the
 * collection cutoff a submission must be accepted before to enter that
 * quarter's freeze.
 */
export function quarterCollectionCutoff(quarterStart: string): string {
  const end = nextQuarterStart(quarterStart); // first day of the month after the quarter
  return `${end.slice(0, 8)}10`;
}

export function quarterIsClosed(quarterStart: string, at: Date): boolean {
  return valuesDayOf(at) >= quarterCollectionCutoff(quarterStart);
}

export function quarterLabel(quarterStart: string): string {
  const [y, m] = quarterStart.split("-").map(Number);
  return `Q${Math.floor((m! - 1) / 3) + 1} ${y}`;
}

export type QuarterlyRating = {
  overall: number | null;
  byValue: Record<CoreValueSlug, PerValueMirror>;
  raterCount: number;
};

/**
 * A quarter's rating — the SAME engine as the rolling mirror, over the
 * quarter's own window. `overall` is the mean of the value averages that
 * cleared the rater floor; a value that never cleared it is absent from the
 * mean, not treated as zero.
 */
export function buildQuarterlyRating(rows: readonly ScoreRow[], weights: ValueWeights, minRaters: number = MIRROR_MIN_RATERS): QuarterlyRating {
  const mirror = buildMirror(rows, weights, minRaters);
  const present = VALUE_SLUGS.map((s) => mirror.byValue[s].average).filter((n): n is number => n != null);
  return {
    overall: present.length > 0 ? present.reduce((s, n) => s + n, 0) / present.length : null,
    byValue: mirror.byValue,
    raterCount: mirror.raterCount,
  };
}
