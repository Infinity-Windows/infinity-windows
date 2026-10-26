import { expect, it } from "vitest";
import type { WorkUnit } from "../../lib/customWork/model";
import type { ActivityRow } from "./activityRows";
import { openingContexts, type ReviewOpening, type ReviewSpec } from "./openingReviewContext";
import { enrichActivityRows } from "./reportingFacts";
import { laborMetricContext } from "./laborMetrics";
import { allUnitFilters, unitMatches } from "./unitReporting";

const opening = { id: "o", project_id: "j", opening_code: "11-1", signature: { v: 1, kind: "window", tiers: [{ story: 2, mix: { fixed: 1 } }], panelCount: 1, movingCount: 0, corner: "none", insetOutset: "outset" }, flag_kind: null, status: "installed" } as ReviewOpening;
const spec = { id: "s", project_id: "j", mark_code: "11", width_in: 24, height_in: 24, confirmed: true, source: "manual", style: "Fixed" } as ReviewSpec;
const row = { id: "r", openingId: "o", unitId: "opening:o", jobId: "j", scope: "Specific", seconds: 600 } as ActivityRow;
it("supplies historical rows, filters and rate denominators from the same opening/spec facts", () => {
  const rows = enrichActivityRows([row], [], openingContexts([opening], [spec]));
  expect(rows[0]).toMatchObject({ category: "Window", subtype: "Fixed", floor: "2", area: 4 });
  expect(rows[0].unitFacts).toMatchObject({ dimensionSource: "Job spec 11 · confirmed spec, not field verified", dimensionsVerified: false });
  expect(unitMatches(rows[0], new Map(), { ...allUnitFilters(), category: ["window"], floor: ["2"], area: ["small"] })).toBe(true);
  expect(laborMetricContext(rows, [], "area").measure(rows).value).toBe(2.5);
});
it("keeps equal-area dimension disagreements visible and unavailable for rate metrics", () => {
  const unit = { id: "u", project_id: "j", opening_id: "o", facts: { width_in: 12, height_in: 48, material: "Aluminum" } } as WorkUnit;
  const rows = enrichActivityRows([{ ...row, unitId: "u" }], [unit], openingContexts([opening], [spec]));
  expect(rows[0].area).toBeNull();
  expect(rows[0].unitFacts?.dimensionConflict).toBe(true);
  expect(unitMatches(rows[0], new Map(), { ...allUnitFilters(), area: ["conflict"] })).toBe(true);
  expect(laborMetricContext(rows, [unit], "area").measure(rows).value).toBeNull();
  expect(laborMetricContext(rows, [unit], "hours").measure(rows).value).toBeCloseTo(1 / 6);
});
it("does not inherit another job's context or attribute General work to a unit", () => {
  const rows = enrichActivityRows([{ ...row, jobId: "other" }, { ...row, scope: "General", unitId: null }], [], openingContexts([opening], [spec]));
  expect(rows[0].unitFacts?.linkConflict).toBe(true);
  expect(rows[0].category).toBeNull();
  expect(laborMetricContext([rows[0]], [], "opening").measure([rows[0]]).value).toBeNull();
  expect(rows[1].unitFacts).toBeUndefined();
});
