import type { WorkUnit } from "../../lib/customWork/model";

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
