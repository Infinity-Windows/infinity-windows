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
  /** Newer saved blocks supersede these units when this block is overdue. */
  supersededOpeningIds?: string[];
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

export function planBoundary(block: Pick<PlanBlock, "startMinute" | "endMinute" | "startPeriod" | "endPeriod">, edge: "start" | "end") {
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

export function currentPlanBlocks(
  blocks: readonly PlanBlock[],
  day: string,
  isUnfinished: (openingId: string, activity: string) => boolean,
  keepCompleted = false,
): PlanBlock[] {
  return blocks.map(block => {
    if (block.kind !== "unit" || block.end >= day) return block;
    const remaining = block.openingIds.filter(id => isUnfinished(id, block.activity) && !block.supersededOpeningIds?.includes(id)
      && !blocks.some(other => other.id !== block.id && other.kind === "unit"
        && other.activity === block.activity && other.openingIds.includes(id)
        && (other.end > block.end || (other.end === block.end && other.id > block.id))));
    if (!remaining.length) return block;
    // Carried work keeps the hours it was planned for; only the day moves
    // (Matt, 2026-11-20: "end time shouldn't adjust with carryover"). A card
    // that ran overnight can end before it starts once it is one day long, so
    // that one runs to the end of its planned day instead.
    const startMinute = planBoundary(block, "start"), planned = planBoundary(block, "end");
    const endMinute = planned > startMinute ? planned : block.dailyEndMinute ?? PLAN_CLOSE;
    return { ...block, start: day, end: day, startMinute, endMinute,
      openingIds: keepCompleted
        ? block.openingIds.filter(id => remaining.includes(id) || !isUnfinished(id, block.activity))
        : remaining };
  });
}
