import type { ProjectOpening } from "./types";

/**
 * Window or door, from whatever the supplier's sheet gave us.
 *
 * The category is the honest answer when the type carries one. When it doesn't,
 * the type code has to be read: a 6070/6080-size sliding unit (`XO`, `OX`, `SC`)
 * is a patio door, not a window that happens to be seven feet tall.
 *
 * Shared so the map pin, the map's list and the dispatch list can never colour
 * the same opening two different ways.
 */
export function openingUnitKind(
  o: Pick<ProjectOpening, "window_types">,
): "door" | "window" {
  const category = (o.window_types?.category ?? "").toLowerCase();
  if (category.includes("door")) return "door";
  if (category.includes("window")) return "window";
  const code =
    `${o.window_types?.type_code ?? ""} ${o.window_types?.name ?? ""}`.toUpperCase();
  if (/\b\d{2}(70|80)\b/.test(code) && /\b(XO|OX|SC)\b/.test(code)) return "door";
  if (/\bDOOR\b/.test(code)) return "door";
  return "window";
}
