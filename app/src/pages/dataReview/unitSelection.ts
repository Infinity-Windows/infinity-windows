import type { SelectedUnit } from "./chartContext";
export function selectedUnitTotals(input: SelectedUnit[]) {
 const units=[...new Map(input.map(u=>[u.id,u])).values()];
 return {count:units.length,area:units.reduce((s,u)=>s+(u.area ?? 0),0),known:units.filter(u=>u.area !== null).length,seconds:units.reduce((s,u)=>s+u.seconds,0),people:new Set(units.flatMap(u=>u.people)).size};
}
