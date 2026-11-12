import { normalizeMarkCode } from "../../lib/fitview/adapter";
import type { ProjectOpening } from "../../lib/install/types";
import building3UnitDetails from "./building3UnitDetails.json";

export const building3ByMark = new Map(
  Object.entries(building3UnitDetails).map(([mark, details]) => [normalizeMarkCode(mark), details]),
);

export function reviewedBuilding3Openings(openings: ProjectOpening[]) {
  return openings.filter(opening => building3ByMark.has(normalizeMarkCode(opening.opening_code)));
}
