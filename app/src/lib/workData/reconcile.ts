/** Read-only workday projection. Payroll remains the time_shifts arithmetic.
 * Sources are claims, not extra payroll: overlapping claims become one
 * conflicted slice. Half-open intervals preserve an atomic switch boundary.
 * Permission filtering must happen before calling this pure projection. */
import { elapsedWorkSeconds, shiftHours } from "../../../../supabase/functions/_shared/timeMath";

export interface EvidenceShift {
  id: string;
  profileId: string;
  projectId: string | null;
  startedAt: string;
  endedAt: string | null;
  breakSeconds: number;
  breakStartedAt: string | null;
  status: string;
  reviewReason?: string | null;
}
export interface EvidenceClaim {
  /** Table + original primary key; aliases never mint a second source. */
  sourceId: string;
  sourceTable: string;
  revision: number | null;
  profileId: string;
  projectId: string | null;
  shiftId: string | null;
  unitId: string | null;
  activityId: string;
  label: string;
  scope: "general" | "specific" | "setup" | "other";
  startedAt: string;
  endedAt: string | null;
  pending?: boolean;
  unresolved?: boolean;
  rework?: boolean;
}
export interface EvidenceBreak {
  sourceId: string;
  shiftId: string;
  startedAt: string;
  endedAt: string;
  paid: boolean;
}
export interface CoverageSlice {
  startedAt: string;
  endedAt: string;
  seconds: number;
  kind: "general" | "specific" | "setup" | "other" | "unknown" | "conflict" | "paidBreak" | "unpaidBreak";
  sourceIds: string[];
}
export interface ShiftCoverage {
  shift: EvidenceShift;
  grossSeconds: number;
  payrollSeconds: number;
  provisional: boolean;
  classifiedSeconds: number;
  unknownSeconds: number;
  conflictSeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  pendingCount: number;
  breakPlacementKnown: boolean;
  issues: string[];
  slices: CoverageSlice[];
}

const time = (v: string) => Date.parse(v);
const iso = (ms: number) => new Date(ms).toISOString();
type Range = { start: number; end: number };
function range(start: string, end: string | null, cutoff: number): Range | null {
  const a = time(start), b = end === null ? cutoff : time(end);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a && cutoff >= a ? { start: a, end: Math.min(b, cutoff) } : null;
}
function uniqueClaims(claims: readonly EvidenceClaim[]) {
  const rows = new Map<string, EvidenceClaim>();
  for (const c of claims) {
    const old = rows.get(c.sourceId);
    if (old && JSON.stringify(old) !== JSON.stringify(c)) throw new Error("Evidence changed while loading. Refresh the report.");
    rows.set(c.sourceId, c);
  }
  return [...rows.values()];
}

/** A missing historical break position is never placed in a guessed gap.
 * When known break intervals disagree with the payroll deduction, retain all
 * raw claims but show the paid total as unknown until the source is resolved. */
export function reconcileShift(
  shift: EvidenceShift,
  claims: readonly EvidenceClaim[],
  breaks: readonly EvidenceBreak[],
  cutoff: number,
): ShiftCoverage {
  if (!Number.isFinite(cutoff)) throw new Error("A valid evidence cutoff is required.");
  const window = range(shift.startedAt, shift.endedAt, cutoff);
  const closed = shift.endedAt !== null;
  const valid = !!window && window.end >= window.start && Number.isFinite(shift.breakSeconds) && shift.breakSeconds >= 0;
  const unresolvedShift = shift.status === "needs_finish" || shift.status === "voided";
  const futureFinish = closed && time(shift.endedAt!) > cutoff;
  const gross = valid ? ((closed ? time(shift.endedAt!) : window!.end) - window!.start) / 1000 : 0;
  const payrollShape = {
    clock_in_at: shift.startedAt, clock_out_at: shift.endedAt,
    break_seconds: shift.breakSeconds, break_started_at: shift.breakStartedAt,
  };
  // Same functions as the existing timecards; closed shifts retain subsecond
  // precision, open shifts retain the existing whole-second live arithmetic.
  const payroll = !valid || unresolvedShift ? 0 : closed
    ? shiftHours(payrollShape) * 3600 : elapsedWorkSeconds(payrollShape, cutoff);
  const rows = uniqueClaims(claims).filter(c => {
    if (c.profileId !== shift.profileId) return false;
    if (c.shiftId === shift.id) return true;
    if (c.shiftId !== null || c.projectId !== shift.projectId) return false;
    const r = range(c.startedAt, c.endedAt, cutoff);
    return !r || !!(window && Math.max(r.start, window.start) < Math.min(r.end, window.end));
  });
  const issues: string[] = [];
  if (!valid) issues.push("invalid_shift");
  if (futureFinish) issues.push("finish_after_snapshot");
  if (shift.status === "needs_finish") issues.push("shift_needs_finish");
  if (shift.reviewReason) issues.push("clock_review_required");
  const pendingCount = rows.filter(c => c.pending).length;
  const claimRanges = rows.filter(c => !c.pending).flatMap(c => {
    const r = range(c.startedAt, c.endedAt, cutoff);
    if (!r) { issues.push(`invalid_claim:${c.sourceId}`); return []; }
    if (c.shiftId === shift.id && c.projectId !== shift.projectId) issues.push(`project_mismatch:${c.sourceId}`);
    if (window && (r.start < window.start || r.end > window.end)) issues.push(`outside_shift:${c.sourceId}`);
    return [{ ...r, c }];
  });
  const breakMap = new Map<string, EvidenceBreak>();
  for (const b of breaks.filter(b => b.shiftId === shift.id)) {
    const old = breakMap.get(b.sourceId);
    if (old && JSON.stringify(old) !== JSON.stringify(b)) throw new Error("Break evidence changed while loading. Refresh the report.");
    breakMap.set(b.sourceId, b);
  }
  const breakRanges = [...breakMap.values()].flatMap(b => {
    const r = range(b.startedAt, b.endedAt, cutoff);
    if (!r || !window || r.start < window.start || r.end > window.end) {
      issues.push(`invalid_break:${b.sourceId}`); return [];
    }
    return [{ ...r, b }];
  });
  if (valid && !closed && shift.breakStartedAt) {
    const r = range(shift.breakStartedAt, null, cutoff);
    if (r && r.start >= window!.start && r.end <= window!.end)
      breakRanges.push({ ...r, b: { sourceId: `time_shifts:${shift.id}:running_break`, shiftId: shift.id,
        startedAt: shift.breakStartedAt, endedAt: iso(cutoff), paid: false } });
    else issues.push("invalid_running_break");
  }
  let unpaid = 0, paidBreak = 0, breakOverlap = false;
  const slices: CoverageSlice[] = [];
  if (valid && !unresolvedShift) {
    const boundaries = [...new Set([window!.start, window!.end,
      ...[...claimRanges, ...breakRanges].flatMap(r => [r.start, r.end])
        .filter(v => v > window!.start && v < window!.end)])].sort((a, b) => a - b);
    for (let i = 1; i < boundaries.length; i++) {
      const start = boundaries[i - 1], end = boundaries[i];
      if (end <= start) continue;
      const active = claimRanges.filter(r => r.start <= start && r.end >= end);
      const onBreak = breakRanges.filter(r => r.start <= start && r.end >= end);
      const seconds = (end - start) / 1000;
      let kind: CoverageSlice["kind"];
      if (onBreak.length > 0) {
        for (const r of active) if (!issues.includes(`activity_during_break:${r.c.sourceId}`)) issues.push(`activity_during_break:${r.c.sourceId}`);
        breakOverlap ||= onBreak.length > 1;
        kind = onBreak.some(r => !r.b.paid) ? "unpaidBreak" : "paidBreak";
        if (kind === "unpaidBreak") unpaid += seconds; else paidBreak += seconds;
      } else if (active.length > 1 || active.some(r => r.c.unresolved || r.c.projectId !== shift.projectId)) kind = "conflict";
      else kind = active[0]?.c.scope ?? "unknown";
      slices.push({ startedAt: iso(start), endedAt: iso(end), seconds, kind,
        sourceIds: [...active.map(r => r.c.sourceId), ...onBreak.map(r => r.b.sourceId)].sort() });
    }
  }
  const deducted = unresolvedShift ? Math.min(gross, valid ? shift.breakSeconds +
    (!closed && shift.breakStartedAt ? Math.max(0, Math.floor((cutoff - time(shift.breakStartedAt)) / 1000)) : 0) : 0)
    : Math.max(0, gross - payroll);
  const liveRounding = !closed && Math.abs(deducted - unpaid) > 0.001 && Math.abs(deducted - unpaid) < 1;
  if (liveRounding) issues.push("live_rounding");
  const breakPlacementKnown = valid && !unresolvedShift && !futureFinish && !breakOverlap &&
    !issues.some(i => i.startsWith("invalid_break") || i === "invalid_running_break") &&
    Math.abs(unpaid - deducted) < 0.001;
  if (breakOverlap) issues.push("overlapping_breaks");
  if (valid && !unresolvedShift && !breakPlacementKnown) issues.push("break_placement_unknown");
  // A scalar deduction gives no proof which source activity lost those seconds.
  // No activity receives a trusted paid attribution until placement reconciles.
  const total = (kind: CoverageSlice["kind"]) => slices.filter(s => s.kind === kind).reduce((n, s) => n + s.seconds, 0);
  const classified = breakPlacementKnown ? total("general") + total("specific") + total("setup") + total("other") : 0;
  const conflict = breakPlacementKnown ? total("conflict") : 0;
  const paid = breakPlacementKnown ? paidBreak : 0;
  return { shift, grossSeconds: gross, payrollSeconds: payroll, provisional: !closed && shift.status === "open",
    classifiedSeconds: classified, conflictSeconds: conflict, paidBreakSeconds: paid,
    unknownSeconds: Math.max(0, payroll - classified - conflict - paid),
    unpaidBreakSeconds: deducted, pendingCount, breakPlacementKnown, issues,
    slices: breakPlacementKnown ? slices : [] };
}

/** Payroll records remain separate when two shifts overlap. Their coverage
 * cannot be trusted: unioning the shifts would silently change recorded pay. */
export function reconcileWorkday(shifts: readonly EvidenceShift[], claims: readonly EvidenceClaim[],
  breaks: readonly EvidenceBreak[], cutoff: number): ShiftCoverage[] {
  const ids = new Set<string>();
  for (const shift of shifts) {
    if (ids.has(shift.id)) throw new Error("Duplicate payroll source. Refresh the report.");
    ids.add(shift.id);
  }
  return shifts.map(shift => {
    const result = reconcileShift(shift, claims, breaks, cutoff);
    const r = range(shift.startedAt, shift.endedAt, cutoff);
    const overlaps = shifts.some(other => {
      if (other.id === shift.id || other.profileId !== shift.profileId || other.status === "voided" || shift.status === "voided") return false;
      const o = range(other.startedAt, other.endedAt, cutoff);
      return r && o && Math.max(r.start, o.start) < Math.min(r.end, o.end);
    });
    return overlaps ? { ...result, classifiedSeconds: 0, conflictSeconds: result.payrollSeconds,
      unknownSeconds: 0, paidBreakSeconds: 0, breakPlacementKnown: false, slices: [],
      issues: [...result.issues, "overlapping_payroll_shifts"] } : result;
  });
}

export interface ActivityTotal { activityId: string; label: string; seconds: number; sourceIds: string[] }
/** Reporting-only exclusive rollup. A source is mapped to one leaf, once.
 * Parent/child cycles and duplicate definitions are rejected before totals. */
export function rollupActivities(rows: readonly ActivityTotal[], mapping: Readonly<Record<string, string>>): ActivityTotal[] {
  const target = (id: string): string => {
    const seen = new Set<string>();
    let next = id;
    while (mapping[next] !== undefined) {
      if (seen.has(next)) throw new Error("Activity groupings cannot contain a cycle.");
      seen.add(next); next = mapping[next];
    }
    return next;
  };
  for (const id of Object.keys(mapping)) target(id);
  const totals = new Map<string, ActivityTotal>();
  for (const row of rows) {
    if (!Number.isFinite(row.seconds) || row.seconds < 0) throw new Error("Invalid activity total.");
    const id = target(row.activityId);
    const old = totals.get(id) ?? { activityId: id, label: id === row.activityId ? row.label : id, seconds: 0, sourceIds: [] };
    old.seconds += row.seconds; old.sourceIds = [...new Set([...old.sourceIds, ...row.sourceIds])];
    totals.set(id, old);
  }
  return [...totals.values()];
}
