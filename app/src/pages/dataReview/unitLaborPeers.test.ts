import { expect, it } from "vitest";
import type { ActivityRow } from "./activityRows";
import type { WorkUnit } from "../../lib/customWork/model";
import { openingContexts, type ReviewOpening, type ReviewSpec } from "./openingReviewContext";
import { unitLaborReview } from "./unitLaborPeers";
const units = Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, opening_id: `o${i}`, project_id: "j", type_label: "Fixed", facts: { material: "Aluminum", width_in: 24, height_in: 24 } })) as WorkUnit[];
const rows = units.map((unit, i) => ({ id: `r${i}`, jobId: "j", scope: "Specific", unitId: unit.id, openingId: unit.opening_id, activity: "Installing", sourceTable: "custom_work_sessions", personId: "p", seconds: (i === 6 ? 100 : 10 + i) * 60, started: `2026-10-${10 + i}T12:00:00Z`, ended: `2026-10-${10 + i}T14:00:00Z` })) as ActivityRow[];
const signature = { v: 1, kind: "window", tiers: [{ story: null, mix: { fixed: 1 } }], panelCount: 1, movingCount: 0, corner: "none", insetOutset: "outset" };
const openings = units.map((unit, i) => ({ id: unit.opening_id, project_id: "j", opening_code: `${i}`, signature, flag_kind: null, status: "installed" })) as ReviewOpening[];
const specs = units.map((_unit, i) => ({ id: `s${i}`, project_id: "j", mark_code: `${i}`, width_in: 24, height_in: 24, confirmed: true, source: "manual", style: "Fixed" })) as ReviewSpec[];
const contexts = openingContexts(openings, specs);
it("flags a high value against other physical units, excluding the candidate from its baseline", () => {
  const review = unitLaborReview(rows, units, "minutes", contexts).find(value => value.unit?.id === "u6")!;
  expect(review.unusual).toBe(true);
  expect(review.peers).toBe(6);
  expect(review.median).toBe(12.5);
  expect(unitLaborReview(rows, units, "area", contexts)[0].value).toBe(25);
});
it("does not manufacture comparisons for small, mismatched, or incomplete cohorts", () => {
  expect(unitLaborReview(rows.slice(0, 3), units, "minutes", contexts).every(value => !value.flagReady && !value.unusual)).toBe(true);
  const flaggedUnits = units.map(unit => ({ ...unit, untimed_work_present: true }));
  expect(unitLaborReview(rows, flaggedUnits, "minutes", contexts).every(value => !value.flagReady)).toBe(true);
  const differentSource = rows.map((row, i) => i === 6 ? { ...row, sourceTable: "unit_sessions" } : row);
  expect(unitLaborReview(differentSource, units, "minutes", contexts).find(value => value.unit?.id === "u6")?.comparable).toBe(false);
});
it("counts people visits on one opening as one sample and blocks overlapping contributor records", () => {
  const repeat = { ...rows[0], id: "repeat" };
  const result = unitLaborReview([...rows, repeat], units, "minutes", contexts);
  expect(result).toHaveLength(7);
  expect(result.find(value => value.unit?.id === "u0")?.problems).toContain("Overlapping records for a contributor");
});

it("compares historical openings across jobs without custom facts, material or dimensions", () => {
  const crossOpenings = openings.map((opening, i) => ({ ...opening, project_id: i === 6 ? "other-job" : "j" }));
  const context = openingContexts(crossOpenings, []);
  const history = rows.map((row, i) => ({ ...row, unitId: `opening:o${i}`, jobId: crossOpenings[i].project_id, sourceTable: "unit_sessions", activity: "Install" }));
  const minutes = unitLaborReview(history, [], "minutes", context);
  expect(minutes.every(value => value.peers === 6 && value.comparable)).toBe(true);
  expect(minutes[0].warnings).toContain("Material unknown; not matched by material");
  expect(unitLaborReview(history, [], "area", context).every(value => value.value === null && !value.comparable)).toBe(true);
});
it("uses scoped spec dimensions and rejects conflicting area without blocking raw minutes", () => {
  const wrongSpecs = specs.map((spec, i) => i === 6 ? { ...spec, width_in: 48 } : spec);
  const context = openingContexts(openings, wrongSpecs);
  const area = unitLaborReview(rows, units, "area", context).find(value => value.unit?.id === "u6")!;
  expect(area.value).toBeNull();
  expect(area.comparable).toBe(false);
  expect(unitLaborReview(rows, units, "minutes", context).find(value => value.unit?.id === "u6")?.comparable).toBe(true);
});
it("does not join equal mark numbers across jobs", () => {
  const context = openingContexts([{ ...openings[0], project_id: "different", signature: null }], specs);
  expect(context.get("o0")?.spec).toBeNull();
});
