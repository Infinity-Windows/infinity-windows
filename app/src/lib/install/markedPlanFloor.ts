/** Use the floor-plan title as evidence. A sheet naming several floors needs review. */
export function markedPlanFloor(text: string) {
  const levels = new Set([...text.matchAll(/\bLEVEL\s+(\d{1,3})\s+FLOOR\s+PLAN\b/gi)]
    .map(match => Number(match[1])));
  return levels.size === 1 ? `Level ${[...levels][0]}` : null;
}

export function markedPlanElevation(text: string) {
  return markedPlanFloor(text) === null && /\bBUILDING\s+[A-Z0-9-]+\s+(?:EXTERIOR\s+)?ELEVATIONS?\b/i.test(text);
}
