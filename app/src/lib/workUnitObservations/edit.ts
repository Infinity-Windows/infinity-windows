import type { WorkUnit } from "../customWork/model";
import { cloneJson, uuid, validate } from "../workConfiguration/model";
import { dimensionObservation, UnitObservationUnavailableError, type UnitFactSnapshot } from "./model";

/** Compose one existing canonical unit command; the caller owns its durable UUID/queue. */
export function unitObservationEdit(unit: WorkUnit, basis: UnitFactSnapshot, observation: unknown): Record<string, unknown> {
  try {
    // Clone first: preserve unrelated facts without evaluating a getter or
    // keeping a mutable form/cache object inside a queued intent.
    const copy=cloneJson(unit) as Record<string,unknown>;
    const factBasis=cloneJson(basis) as Record<string,unknown>;
    const id=uuid(copy.id);
    if (id!==factBasis.unitId) throw new UnitObservationUnavailableError();
    validate.integer(copy.revision,1,Number.MAX_SAFE_INTEGER-1);
    validate.integer(factBasis.revision,0,Number.MAX_SAFE_INTEGER-1);
    for (const key of ["project_id","opening_id"]) if (copy[key]!==null) uuid(copy[key]);
    if (typeof copy.label!=="string" || !copy.label.trim() || typeof copy.type_label!=="string") throw new UnitObservationUnavailableError();
    if (!copy.facts || typeof copy.facts!=="object" || Array.isArray(copy.facts)) throw new UnitObservationUnavailableError();
    const facts={...copy.facts as Record<string,unknown>};
    // The server records the previous tuple from its locked unit row. Old
    // dimension values must not be supplied as contradictory new values.
    for (const key of ["width_in","height_in","measurement_source","area_source"]) delete facts[key];
    return freezeJson({id,revision:copy.revision,project_id:copy.project_id,opening_id:copy.opening_id,label:copy.label,type_label:copy.type_label,
      facts,dimension_observation:dimensionObservation(observation),expected_fact_revision:factBasis.revision});
  } catch { throw new UnitObservationUnavailableError(); }
}
function freezeJson<T>(value:T):T {
  if (value && typeof value==="object") { for(const child of Object.values(value)) freezeJson(child);Object.freeze(value); }
  return value;
}
