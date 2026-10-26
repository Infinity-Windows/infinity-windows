import type { ChartScope } from "./chartContext";
export const selectedRecordIds = (scopes: ChartScope[]) => new Set(scopes.flatMap(scope => scope.ids));
export function toggleChartScope(scopes: ChartScope[], target: ChartScope): ChartScope[] {
  const selected = selectedRecordIds(scopes);
  const remove = target.ids.every(id => selected.has(id));
  const targetIds = new Set(target.ids);
  const rest = scopes.map(scope => ({ ...scope, ids: scope.ids.filter(id => !targetIds.has(id)) })).filter(scope => scope.ids.length);
  return remove ? rest : [...rest, target];
}
