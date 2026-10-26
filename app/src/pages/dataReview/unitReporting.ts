import type { WorkUnit } from "../../lib/customWork/model";
import type { ActivityRow } from "./activityRows";

export type UnitFacet = "floor" | "material" | "area";
export type UnitFilters = Record<UnitFacet, string[] | null> & { category?: string[] | null; subtype?: string[] | null; configuration?: string[] | null; system?: string[] | null };
export const allUnitFilters = (): UnitFilters => ({ floor: null, material: null, area: null, category: null, subtype: null, configuration: null, system: null });
export const areaOptions = [
  { key: "small", label: "0–25 ft²" }, { key: "medium", label: ">25–50 ft²" },
  { key: "large", label: ">50–100 ft²" }, { key: "xl", label: ">100 ft²" },
  { key: "unknown", label: "Missing / invalid size" },
  { key: "conflict", label: "Conflicting dimensions" },
];
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
export function unitReporting(unit?: WorkUnit) {
  const story = clean(unit?.facts.story);
  const numericFloor = /^(\d+)(?:st|nd|rd|th)?$/i.exec(story);
  const floor = numericFloor ? numericFloor[1] : story.toLowerCase() || "unknown";
  const material = clean(unit?.facts.material).toLowerCase() || "unknown";
  const width = unit?.facts.width_in, height = unit?.facts.height_in;
  const area = typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width * height / 144 : null;
  const usableArea = area !== null && Number.isFinite(area) ? area : null;
  return {
    floor, floorLabel: floor === "unknown" ? "Unknown floor" : numericFloor ? `Floor ${floor}` : story,
    material, materialLabel: material === "unknown" ? "Unknown material" : clean(unit?.facts.material),
    area: usableArea, areaBand: usableArea === null ? "unknown" : usableArea <= 25 ? "small" : usableArea <= 50 ? "medium" : usableArea <= 100 ? "large" : "xl",
    dimensionSource: clean(unit?.facts.measurement_source) || clean(unit?.facts.area_source) || null,
    dimensionsVerified: false as const,
    source: "current-unit-facts" as const,
  };
}
export function unitMatches(row: ActivityRow, units: Map<string, WorkUnit>, filters: UnitFilters) {
  // General labor has no unit attribution: unit filters never remove it.
  if (row.scope !== "Specific") return true;
  const facts = row.unitFacts ?? unitReporting(row.unitId ? units.get(row.unitId) : undefined);
  return (["floor", "material", "area", "category", "subtype", "configuration", "system"] as const).every(key => {
    const selected = filters[key];
    const value = key === "area" ? row.unitFacts?.dimensionConflict ? "conflict" : facts.areaBand : key === "category" || key === "subtype" || key === "configuration" || key === "system" ? row[key]?.toLowerCase() || "unknown" : facts[key];
    return selected == null || selected.includes(value);
  });
}
