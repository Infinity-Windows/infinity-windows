import { useId } from "react";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import type { DimensionDraft, MeasurementSource, MeasurementUnit } from "../../lib/workUnitObservations/model";
import "./DimensionObservationFields.css";

/** Controlled draft only: choosing dimensions never starts work or saves evidence. */
export function DimensionObservationFields({ value, onChange, disabled=false, invalid=false }: {
  value: DimensionDraft;
  onChange: (value: DimensionDraft) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const t=useT(), id=useId(), help=`${id}-help`, error=`${id}-error`;
  return <fieldset className="dimension-observation" disabled={disabled} aria-describedby={`${help}${invalid?` ${error}`:""}`}>
    <legend>{t("work.dimension.title")}</legend>
    <div className="dimension-observation-pair">
      <label>{t("work.dimension.width")}<input required inputMode="decimal" value={value.width} aria-invalid={invalid || undefined} onChange={e=>onChange({...value,width:e.target.value})} /></label>
      <label>{t("work.dimension.height")}<input required inputMode="decimal" value={value.height} aria-invalid={invalid || undefined} onChange={e=>onChange({...value,height:e.target.value})} /></label>
    </div>
    <label>{t("work.dimension.unit")}<select value={value.unit} onChange={e=>onChange({...value,unit:e.target.value as MeasurementUnit})}>
      <option value="in">{t("work.dimension.in")}</option><option value="ft">{t("work.dimension.ft")}</option><option value="mm">{t("work.dimension.mm")}</option><option value="cm">{t("work.dimension.cm")}</option>
    </select></label>
    <label>{t("work.dimension.source")}<select required value={value.source} aria-invalid={invalid || undefined} onChange={e=>onChange({...value,source:e.target.value as MeasurementSource | ""})}>
      <option value="">{t("work.dimension.choose")}</option><option value="measured">{t("work.dimension.measured")}</option><option value="plans">{t("work.dimension.plans")}</option><option value="estimated">{t("work.dimension.estimated")}</option>
    </select></label>
    <label>{t("work.dimension.reference")}<input value={value.reference} maxLength={1000} aria-describedby={`${id}-reference-help`} onChange={e=>onChange({...value,reference:e.target.value})} /></label>
    <p id={`${id}-reference-help`} className="muted">{t("work.dimension.referenceHelp")}</p>
    <p id={help} className="muted">{t("work.dimension.help")}</p>
    {value.source==="estimated" && <p className="dimension-observation-estimate">{t("work.dimension.estimateHelp")}</p>}
    {invalid && <p id={error} role="alert">{t("work.dimension.invalid")}</p>}
  </fieldset>;
}
