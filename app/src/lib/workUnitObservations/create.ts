import { cloneJson, uuid, validate } from "../workConfiguration/model";
import { dimensionObservation, type DimensionObservation } from "./model";

/** Existing canonical unit writer owns creation and exact server conversion.
 * A creation request never supplies reviewer, observer or trusted-area claims. */
export function unitCreationObservation(value: Record<string, unknown>, observation: DimensionObservation): Record<string, unknown> {
  const copy = cloneJson(value) as Record<string, unknown>;
  uuid(copy.id); uuid(copy.project_id);
  if (copy.revision !== 0 || copy.opening_id !== null) throw new Error("Use a fresh selected-job unit draft.");
  const facts = { ...validate.object(copy.facts, [], Object.keys(copy.facts as object)) };
  for (const key of ["width_in", "height_in", "measurement_source", "area_source"]) delete facts[key];
  return { ...copy, facts, expected_fact_revision: 0, dimension_observation: dimensionObservation(observation) };
}
