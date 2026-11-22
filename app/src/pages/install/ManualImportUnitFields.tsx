import { DimensionFields } from "../../components/install/DimensionFields";
import { MM_PER_INCH } from "../../lib/install/dimensionEntry";
import { SET_DEPTHS } from "../../lib/install/buildFacts";
import { isUnitKind, UNIT_KINDS, unitKindLabel } from "../../lib/install/unitDetails";
import type { ManualImportDefinition } from "../../lib/install/unitImportFinish";

export const NO_CAD = "no-cad";

export function ManualImportUnitFields({ value, onChange, onValidChange }: {
  value: ManualImportDefinition;
  onChange: (definition: ManualImportDefinition) => void;
  onValidChange: (valid: boolean) => void;
}) {
  return <fieldset className="cad-import-fields">
    <legend>Unit details</legend>
    <label>Type <select required value={value.kind ?? ""} onChange={event => {
      const kind = event.target.value;
      onChange({ ...value, kind: isUnitKind(kind) ? kind : null });
    }}>
      <option value="">Choose type</option>
      {UNIT_KINDS.map(kind => <option key={kind} value={kind}>{unitKindLabel(kind)}</option>)}
    </select></label>
    <label>Material <input value={value.material ?? ""} onChange={event => onChange({ ...value, material: event.target.value })}/></label>
    <label className="ub-span">Configuration <input value={value.configuration ?? ""}
      onChange={event => onChange({ ...value, configuration: event.target.value })}/></label>
    <details className="ub-span ub-disclosure">
      <summary>More unit details</summary>
      <div className="cad-import-fields">
        <DimensionFields width={value.width == null ? null : value.width * MM_PER_INCH}
          height={value.height == null ? null : value.height * MM_PER_INCH}
          onValidChange={onValidChange}
          onChange={(side, mm) => onChange({ ...value, [side]: mm == null ? null : mm / MM_PER_INCH })}/>
        <label>Measurement basis <select value={value.basis ?? ""} onChange={event => {
          const basis = event.target.value;
          onChange({ ...value, basis: basis === "unit" || basis === "rough" || basis === "drawing" ? basis : null });
        }}>
          <option value="">Unspecified</option><option value="unit">Outside frame</option>
          <option value="rough">Rough opening</option><option value="drawing">Drawing size</option>
        </select></label>
        <label>Inset/outset <select value={value.inset ?? ""} onChange={event => {
          onChange({ ...value, inset: SET_DEPTHS.find(depth => depth === event.target.value) ?? null });
        }}>
          <option value="">Unspecified</option><option value="inset">Inset</option>
          <option value="outset">Outset</option><option value="unknown">Unknown</option>
        </select></label>
      </div>
    </details>
  </fieldset>;
}
