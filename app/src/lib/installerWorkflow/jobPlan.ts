export const BUILDING_3_PROJECT = "c8bf4d94-5086-40ed-9d8c-b3c88add2229";

export type PlanPeriod = "AM" | "PM";

export type OpeningCrew = { leadId?: string; crewIds: string[] };

export interface PlanBlock {
  id: string;
  activity: string;
  kind: "unit" | "general";
  start: string;
  end: string;
  startPeriod?: PlanPeriod;
  endPeriod?: PlanPeriod;
  startMinute?: number;
  endMinute?: number;
  dailyEndMinute?: number;
  openingIds: string[];
  installerIds: string[];
  openingCrew?: Record<string, OpeningCrew>;
  /** Legacy unit blocks assigned their roster to the entire block. */
  unitCrewOnly?: true;
}

export function shiftPlanDate(date: string, days: number) {
  const value = new Date(date + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function planDaysBetween(start: string, end: string) {
  return (Date.parse(end) - Date.parse(start)) / 86_400_000;
}

export const PLAN_OPEN = 7 * 60;
export const PLAN_NOON = 12 * 60;
export const PLAN_CLOSE = 19 * 60;
export const STANDARD_SHIFT_END = 16 * 60;
export const PLAN_STEP = 15;

export function planBoundary(block: PlanBlock, edge: "start" | "end") {
  return edge === "start"
    ? block.startMinute ?? (block.startPeriod === "PM" ? PLAN_NOON : PLAN_OPEN)
    : block.endMinute ?? (block.endPeriod === "AM" ? PLAN_NOON : PLAN_CLOSE);
}

export function planDayEnd(block: PlanBlock, date: string) {
  return block.end === date ? planBoundary(block, "end") : block.dailyEndMinute ?? PLAN_CLOSE;
}

export function coversPlanSlot(block: PlanBlock, date: string, period: PlanPeriod) {
  return date >= block.start && date <= block.end
    && (date !== block.start || planBoundary(block, "start") < (period === "AM" ? PLAN_NOON : PLAN_CLOSE))
    && planDayEnd(block, date) > (period === "AM" ? PLAN_OPEN : PLAN_NOON);
}

/** Merge overlapping or touching work for the same crew and activity. */
export function mergeDroppedAssignment(blocks: PlanBlock[], dropped: PlanBlock) {
  let merged = dropped;
  const absorbed = new Set([dropped.id]);
  const crewKey = (block: PlanBlock) => [...new Set(block.installerIds)].sort().join(",");
  const crew = crewKey(dropped);
  const hasOpeningCrew = (block: PlanBlock) => block.unitCrewOnly || Object.keys(block.openingCrew ?? {}).length > 0;
  const boundary = (block: PlanBlock, edge: "start" | "end") =>
    planDaysBetween("1970-01-01", block[edge]) * 1440 + planBoundary(block, edge);
  const dailyEnd = (block: PlanBlock) => block.start !== block.end
    ? block.dailyEndMinute ?? PLAN_CLOSE : undefined;
  const nextShift = (left: PlanBlock, right: PlanBlock, cutoff: number) =>
    shiftPlanDate(left.end, 1) === right.start
    && planBoundary(left, "end") === cutoff && planBoundary(right, "start") === PLAN_OPEN;

  // Expanding the interval can connect another assignment earlier in the list.
  let expanded = true;
  while (crew && expanded) {
    expanded = false;
    for (const block of blocks) {
      if (hasOpeningCrew(dropped) || hasOpeningCrew(block) || absorbed.has(block.id) || block.kind !== dropped.kind || block.activity !== dropped.activity || crewKey(block) !== crew) continue;
      const existingCutoff = dailyEnd(merged);
      const otherCutoff = dailyEnd(block);
      if (existingCutoff !== undefined && otherCutoff !== undefined && existingCutoff !== otherCutoff) continue;
      const cutoff = existingCutoff ?? otherCutoff;
      const overnight = [STANDARD_SHIFT_END, PLAN_CLOSE].find(end =>
        (cutoff === undefined || cutoff === end) && (nextShift(block, merged, end) || nextShift(merged, block, end)));
      if (overnight === undefined && (boundary(block, "end") < boundary(merged, "start") || boundary(block, "start") > boundary(merged, "end"))) continue;
      const start = boundary(block, "start") < boundary(merged, "start") ? block : merged;
      const end = boundary(block, "end") > boundary(merged, "end") ? block : merged;
      merged = {
        ...merged, start: start.start, startMinute: planBoundary(start, "start"),
        end: end.end, endMinute: planBoundary(end, "end"),
        dailyEndMinute: cutoff ?? overnight,
        openingIds: merged.openingIds.length && block.openingIds.length
          ? [...new Set([...merged.openingIds, ...block.openingIds])] : [],
      };
      absorbed.add(block.id);
      expanded = true;
    }
  }
  return { merged, absorbed };
}

function storageKey(project: string, account: string) {
  // Keep the existing Building 3 storage key so manually created blocks survive.
  const version = project === BUILDING_3_PROJECT ? "sample-v4-first-week" : "v1";
  return `forge:job-plan:${version}:${account}:${project}`;
}

export function readJobPlan(project: string, account: string, initial: PlanBlock[] = []): PlanBlock[] {
  try {
    const saved = localStorage.getItem(storageKey(project, account));
    if (saved === null) return initial;
    const blocks: PlanBlock[] = JSON.parse(saved);
    return project === BUILDING_3_PROJECT ? blocks.filter(block => !block.id.startsWith("demo-")) : blocks;
  } catch {
    return [];
  }
}

export function saveJobPlan(project: string, account: string, blocks: PlanBlock[]) {
  localStorage.setItem(storageKey(project, account), JSON.stringify(blocks));
}
