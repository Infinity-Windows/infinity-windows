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

function storageKey(project: string, account: string) {
  // Keep the existing Building 3 storage key so manually created blocks survive.
  const version = project === BUILDING_3_PROJECT ? "sample-v4-first-week" : "v1";
  return `forge:job-plan:${version}:${account}:${project}`;
}

export function readJobPlan(project: string, account: string): PlanBlock[] {
  try {
    const saved = localStorage.getItem(storageKey(project, account));
    if (saved === null) return [];
    const blocks: PlanBlock[] = JSON.parse(saved);
    return project === BUILDING_3_PROJECT ? blocks.filter(block => !block.id.startsWith("demo-")) : blocks;
  } catch {
    return [];
  }
}

export function saveJobPlan(project: string, account: string, blocks: PlanBlock[]) {
  localStorage.setItem(storageKey(project, account), JSON.stringify(blocks));
}
