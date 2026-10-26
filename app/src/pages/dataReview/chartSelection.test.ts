import { expect, it } from "vitest";
import { selectedRecordIds, toggleChartScope } from "./chartSelection";
it("removes nested records from ancestor scopes and preserves unrelated selections", () => {
  const parent = { key:"parent", label:"Parent", ids:["a","b","c"] };
  const other = { key:"other", label:"Other", ids:["d"] };
  const partial = toggleChartScope([parent, other], { key:"child", label:"Child", ids:["b"] });
  expect([...selectedRecordIds(partial)]).toEqual(["a","c","d"]);
  const restored = toggleChartScope(partial, parent);
  expect([...selectedRecordIds(restored)].sort()).toEqual(["a","b","c","d"]);
  expect(toggleChartScope(restored, parent)).toEqual([other]);
});
