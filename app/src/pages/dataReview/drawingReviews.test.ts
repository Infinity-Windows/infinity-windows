import { expect, it } from "vitest";
import { resolveReportingFacts, enrichActivityRows } from "./reportingFacts";
import { reviewedPlanset, reviewedProject } from "./drawingReviews";
import type { OpeningContext } from "./openingReviewContext";
import type { ActivityRow } from "./activityRows";
import { unitFactCoverage } from "./unitFactCoverageData";
import { allUnitFilters, unitMatches } from "./unitReporting";
const contexts = [
  ["2", "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)", "Fixed", 23.5, 59.5, "window", "door"],
  ["3", "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)", "Fixed", 35.5, 95.5, "window", "door"],
  ["14", "Thermal Break Aluminum Fixed Window(lines up with door on line 24)(1 3/8\" Nail Fins)", "Fixed", 191.125, 35.5, "door", "window"],
  ["16", "Thermal Break Aluminum Fixed Window(lines up with door on line 25)(1 3/8\" Nail Fins)", "Fixed", 191.5, 23.5, "door", "window"],
  ["23", "2 Track Thermal break Aluminum Sliding Door with Thermal Break Aluminum Fixed Window(1 panel Fixed)(New Track) (Outside View)", "Sliding/Fixed", 143.5, 107.5, "door", "window"],
  ["33", "Thermal break Aluminum French Door(Threshold same as Picture)(1 3/8\" Nail Fins) (Outside View)", "Inward opening", 35.5, 95.5, "door", "window"],
].map(([mark, style, operation, width, height, kind, catalog]) => ({
  opening: { id: `o${mark}`, project_id: reviewedProject, opening_code: mark, signature: null },
  spec: { id: `s${mark}`, project_id: reviewedProject, planset_id: reviewedPlanset, mark_code: mark, style, operation, width_in: width, height_in: height, unit_kind: kind },
  catalogType: { id: "catalog", name: "", category: catalog }, specConflict: false,
} as OpeningContext));
it("uses all six drawing-reviewed categories while retaining source disagreements and effective filters", () => {
  const rows = enrichActivityRows(contexts.map(context => ({ id: context.opening.id, scope: "Specific", jobId: reviewedProject, openingId: context.opening.id, seconds: 60 } as ActivityRow)), [], new Map(contexts.map(context => [context.opening.id, context])));
  expect(rows.map(row => row.category)).toEqual(["Window", "Window", "Window", "Window", "Door", "Door"]);
  for (const row of rows) {
    expect(row.unitFacts?.classification.category.status).toBe("conflict");
    expect(row.unitFacts?.sourceClassification.category.evidence.some(e => e.source === "Linked catalog category")).toBe(true);
    expect(row.unitFacts?.review).not.toBeNull();
    expect(row.unitFacts?.warnings.join(" ")).toContain("Conflicting category");
  }
  expect(unitMatches(rows[0], new Map(), { ...allUnitFilters(), category: ["window"] })).toBe(true);
  expect(unitFactCoverage(rows).fields.find(field => field.field === "category")).toMatchObject({ reviewed: 6, conflict: 6 });
});
it("holds #14 area even without custom dimensions and leaves #23 configuration disputed", () => {
  const fixed = resolveReportingFacts(undefined, contexts[2]);
  expect(fixed.area).toBeNull(); expect(fixed.dimensionConflict).toBe(true);
  expect(fixed.warnings.join(" ")).toContain("rough opening");
  const sliding = resolveReportingFacts(undefined, contexts[4]);
  expect(sliding.configuration).toBe("Conflicting configuration");
  expect(sliding.classification.configuration.evidence.map(e => e.value)).toContain("2 fixed panels · 1 sliding leaf");
  expect(resolveReportingFacts(undefined, contexts[5]).configuration).toContain("Single leaf");
});
it("does not reuse a review across jobs, uploads, changed specs, ambiguous specs or bad links", () => {
  const context = contexts[0];
  for (const other of [
    { ...context, opening: { ...context.opening, project_id: "other" } },
    { ...context, spec: { ...context.spec!, planset_id: "replacement" } },
    { ...context, spec: { ...context.spec!, style: "Changed window" } },
    { ...context, specConflict: true },
  ]) expect(resolveReportingFacts(undefined, other).review).toBeNull();
  expect(resolveReportingFacts(undefined, context, "other").review).toBeNull();
  expect(resolveReportingFacts(undefined, contexts[3]).system).toBeNull();
});
