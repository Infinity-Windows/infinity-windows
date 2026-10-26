import { expect, it } from "vitest";
import type { WorkUnit } from "../../lib/customWork/model";
import type { OpeningContext } from "./openingReviewContext";
import { resolveUnitTaxonomy } from "./unitTaxonomy";
import { enrichActivityRows } from "./reportingFacts";
import { unitFactCoverage } from "./unitFactCoverageData";
import type { ActivityRow } from "./activityRows";
const unit = { id: "u", project_id: "j", opening_id: "o", type_label: "Unknown", facts: {} } as WorkUnit;
const context = { opening: { id: "o", project_id: "j", opening_code: "1", signature: null }, spec: { id: "s", project_id: "j", mark_code: "1", style: "Thermal break aluminum sliding door", operation: "XO", unit_kind: "door", door_kind: "slider" }, specConflict: false } as OpeningContext;
it("recovers classification from job-specific fields with source evidence and keeps brand/unknown descriptions unmapped", () => {
  const facts = resolveUnitTaxonomy(unit, context);
  expect(facts.category).toMatchObject({ value: "Door", status: "known" });
  expect(facts.subtype).toMatchObject({ value: "Sliding", status: "known" });
  expect(facts.material).toMatchObject({ value: "Aluminum", status: "known" });
  expect(facts.material.evidence[0].source).toContain("derived");
  const unknown = resolveUnitTaxonomy({ ...unit, type_label: "Operable" }, { ...context, spec: { ...context.spec!, style: "Andersen 100 black", operation: null, unit_kind: null, door_kind: null } });
  expect(unknown.category.status).toBe("unknown"); expect(unknown.subtype.status).toBe("unknown"); expect(unknown.material.status).toBe("unknown");
});
it("preserves disagreeing catalog, custom and spec classifications instead of choosing a winner", () => {
  const result = resolveUnitTaxonomy({ ...unit, type_label: "Fixed window", facts: { material: "Vinyl" } }, { ...context, catalogType: { id: "t", name: "Casement window", category: "casement" } });
  for (const field of ["category", "subtype", "material"] as const) { expect(result[field].status).toBe("conflict"); expect(result[field].value).toBeNull(); }
  expect(result.category.evidence.some(item => item.raw === "Fixed window")).toBe(true);
});
it("uses explicit catalog links and normalizes slider panels without treating fixed sidelights as a contradiction", () => {
  const result = resolveUnitTaxonomy(unit, { ...context, opening: { ...context.opening, signature: { v: 1, kind: "door", tiers: [{ story: null, mix: { fixed: 1, sliderx2: 2 } }], panelCount: 3, movingCount: 2, corner: "none", insetOutset: null } } });
  expect(result.subtype.value).toBe("Sliding");
  const linked = resolveUnitTaxonomy(unit, { ...context, spec: null, catalogType: { id: "t", name: "Vinyl casement window", category: "casement" } });
  expect(linked.category.value).toBe("Window"); expect(linked.subtype.value).toBe("Casement"); expect(linked.material.value).toBe("Vinyl");
});
it("separates French and pivot configuration from hinged operation without fabricating a Storefront category", () => {
  const result = resolveUnitTaxonomy({ ...unit, type_label: "Pivot door" }, { ...context, spec: { ...context.spec!, style: "French door", door_kind: "french", operation: "hinged" } });
  expect(result.subtype.value).toBe("Hinged");
  expect(result.configuration.value).toContain("French");
  expect(result.configuration.value).toContain("Pivot");
  expect(resolveUnitTaxonomy({ ...unit, type_label: "Storefront" }).category.status).toBe("unknown");
});
it("rejects wrong opening links and counts recovery per physical unit, not timer row", () => {
  const row = { id: "a", scope: "Specific", jobId: "j", openingId: "o", unitId: "u", seconds: 60 } as ActivityRow;
  const rows = enrichActivityRows([row, { ...row, id: "b" }], [unit], new Map([["o", context]]));
  const coverage = unitFactCoverage(rows);
  expect(coverage.units).toBe(1);
  for (const field of coverage.fields.filter(field => ["category", "subtype", "material"].includes(field.field))) expect(field).toMatchObject({ before: 0, known: 1, recovered: 1, conflict: 0, unknown: 0 });
  const bad = enrichActivityRows([row], [{ ...unit, opening_id: "different" }], new Map([["o", context]]))[0];
  expect(bad.unitFacts?.linkConflict).toBe(true); expect(bad.category).toBeNull(); expect(bad.unitFacts?.classification.material.status).toBe("unknown");
});

it("keeps system independent of category and refuses to infer storefront from aluminum", () => {
  const result = resolveUnitTaxonomy(unit, { ...context, spec: { ...context.spec!, style: "Aluminum storefront sliding door with fixed sidelights", operation: "Sliding/Fixed" } });
  expect(result.category.value).toBe("Door");
  expect(result.subtype.value).toBe("Sliding");
  expect(result.system.value).toBe("Storefront");
  expect(result.configuration.value).toBe("Sidelights");
  expect(resolveUnitTaxonomy(unit, context).system.status).toBe("unknown");
  const conflict = resolveUnitTaxonomy({ ...unit, type_label: "Curtain wall" }, { ...context, spec: { ...context.spec!, product_line: "Storefront" } });
  expect(conflict.system.status).toBe("conflict");
});
it("distinguishes total and fixed panels and preserves contradictory track counts", () => {
  const result = resolveUnitTaxonomy(unit, { ...context, spec: { ...context.spec!, style: "4Track 4 Panel Aluminum Sliding Door(1 panel Fixed)", operation: "Sliding (1 panel Fixed)" } });
  expect(result.configuration).toMatchObject({ status: "known", value: "1 fixed panel · 4 panels · 4 tracks" });
  const conflict = resolveUnitTaxonomy(unit, { ...context, spec: { ...context.spec!, style: "2 Track sliding door", operation: "3 Track sliding" } });
  expect(conflict.configuration.status).toBe("conflict");
});
it("keeps new facets selectable including unknown and conflicting classifications", async () => {
  const { allUnitFilters, unitMatches } = await import("./unitReporting");
  const { dimensionValue } = await import("./dataDimensions");
  const row = { scope: "Specific", system: "Conflicting system", configuration: "Sidelights" } as ActivityRow;
  expect(unitMatches(row, new Map(), { ...allUnitFilters(), system: ["conflicting system"] })).toBe(true);
  expect(unitMatches(row, new Map(), { ...allUnitFilters(), configuration: ["pair"] })).toBe(false);
  expect(dimensionValue(row, "system").key).toBe("Conflicting system");
  expect(dimensionValue({ ...row, system: null }, "system").key).toBe("Unknown");
});
