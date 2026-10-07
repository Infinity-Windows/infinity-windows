import { useId } from "react";
import type { TypedField } from "../../lib/workConfiguration/model";
import type { AnswerDraft, AnswerDraftValue, AnswerIssue } from "../../lib/workConfiguration/answers";
import "./ActivityAnswerFields.css";

export interface ActivityAnswerFieldsProps {
  /** Already parsed fields from the exact published definition version. */
  fields: readonly TypedField[];
  value: AnswerDraft;
  onChange: (next: AnswerDraft) => void;
  locale: "en" | "es";
  disabled?: boolean;
  invalid?: Readonly<Record<string, AnswerIssue>>;
}

const words = {
  en: {
    title: "Activity details", required: "Required", choose: "Choose an answer", yes: "Yes", no: "No",
    textLimit: "Up to 500 characters", requiredError: "Choose or enter an answer.",
    invalidError: "Check this answer.", tooLongError: "Use 500 characters or fewer.",
    rangeError: "Enter a number within the allowed range.", unknownError: "Unknown field.",
    schemaError: "Activity details are unavailable.",
  },
  es: {
    title: "Detalles de la actividad", required: "Obligatorio", choose: "Elige una respuesta", yes: "Sí", no: "No",
    textLimit: "Hasta 500 caracteres", requiredError: "Elige o escribe una respuesta.",
    invalidError: "Revisa esta respuesta.", tooLongError: "Usa 500 caracteres o menos.",
    rangeError: "Escribe un número dentro del rango permitido.", unknownError: "Campo desconocido.",
    schemaError: "Los detalles de la actividad no están disponibles.",
  },
} as const;

export function ActivityAnswerFields({ fields, value, onChange, locale, disabled = false, invalid }: ActivityAnswerFieldsProps) {
  const prefix = useId().replaceAll(":", "");
  const t = words[locale];
  function set(id: string, answer: AnswerDraftValue) { onChange({ ...value, [id]: answer }); }
  function issueText(issue: AnswerIssue): string {
    switch (issue) {
      case "required": return t.requiredError;
      case "too_long": return t.tooLongError;
      case "out_of_range": return t.rangeError;
      case "unknown_field": return t.unknownError;
      case "invalid_schema": return t.schemaError;
      default: return t.invalidError;
    }
  }
  return <fieldset className="paf" disabled={disabled} aria-label={t.title}>
    <legend>{t.title}</legend>
    {fields.map((field) => {
      const id = `${prefix}-${field.id}`;
      const errorId = `${id}-error`;
      const issue = invalid?.[field.id];
      const current = value[field.id];
      const label = locale === "en" ? field.label_en : field.label_es;
      return <div className="paf-field" key={field.id}>
        {field.type === "multi_select"
          ? <span id={id} className="paf-group-label">{label}{field.required && <span className="paf-required"> · {t.required}</span>}</span>
          : <label htmlFor={id}>{label}{field.required && <span className="paf-required"> · {t.required}</span>}</label>}
        {field.type === "text" && <>
          <input id={id} type="text" value={typeof current === "string" ? current : ""} disabled={disabled}
            aria-required={field.required} aria-invalid={!!issue} aria-describedby={issue ? errorId : undefined}
            onChange={(event) => set(field.id, event.target.value)} />
          <small>{t.textLimit}</small>
        </>}
        {field.type === "number" && <div className="paf-number">
          <input id={id} type="text" inputMode="decimal" value={typeof current === "string" ? current : ""} disabled={disabled}
            aria-required={field.required} aria-invalid={!!issue} aria-describedby={issue ? errorId : undefined}
            onChange={(event) => set(field.id, event.target.value)} />
          {field.unit && <span className="paf-unit" aria-label={field.unit}>{field.unit}</span>}
        </div>}
        {field.type === "boolean" && <select id={id} value={typeof current === "boolean" ? String(current) : ""} disabled={disabled}
          aria-required={field.required} aria-invalid={!!issue} aria-describedby={issue ? errorId : undefined}
          onChange={(event) => set(field.id, event.target.value === "" ? null : event.target.value === "true")}>
          <option value="">{t.choose}</option><option value="true">{t.yes}</option><option value="false">{t.no}</option>
        </select>}
        {field.type === "single_select" && <select id={id} value={typeof current === "string" ? current : ""} disabled={disabled}
          aria-required={field.required} aria-invalid={!!issue} aria-describedby={issue ? errorId : undefined}
          onChange={(event) => set(field.id, event.target.value)}>
          <option value="">{t.choose}</option>
          {field.options?.map((option) => <option key={option.id} value={option.id}>{locale === "en" ? option.label_en : option.label_es}</option>)}
        </select>}
        {field.type === "multi_select" && <div className="paf-options" role="group" aria-labelledby={id}
          aria-required={field.required} aria-invalid={!!issue} aria-describedby={issue ? errorId : undefined}>
          {field.options?.map((option) => {
            const selected = Array.isArray(current) && current.includes(option.id);
            return <label key={option.id} className="paf-check">
              <input type="checkbox" value={option.id} checked={selected} disabled={disabled}
                onChange={(event) => {
                  const existing = Array.isArray(current) ? current : [];
                  set(field.id, event.target.checked
                    ? [...existing.filter((item) => item !== option.id), option.id]
                    : existing.filter((item) => item !== option.id));
                }} />
              <span>{locale === "en" ? option.label_en : option.label_es}</span>
            </label>;
          })}
        </div>}
        {issue && <p id={errorId} className="paf-error" role="alert">{issueText(issue)}</p>}
      </div>;
    })}
    {invalid?._form && <p className="paf-error" role="alert">{issueText(invalid._form)}</p>}
  </fieldset>;
}
