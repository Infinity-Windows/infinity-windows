import type { ReactNode } from "react";

/** Labeled text/number/datetime input for the travel editors. */
export function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "number" | "date" | "datetime-local" | "time" | "tel";
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="travel-field">
      <span className="travel-field-label">{label}</span>
      <input
        className="travel-input"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="travel-field-hint muted">{hint}</span>}
    </label>
  );
}

/** Labeled multiline input. */
export function AreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label className="travel-field">
      <span className="travel-field-label">{label}</span>
      <textarea
        className="travel-input travel-textarea"
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * The tick the travel section draws for itself.
 *
 * The native checkbox is still in the DOM, and still the thing that gets
 * checked, focused and read out — it is only taken out of the picture, because
 * the app's global `input, select` rule sizes every input for a gloved thumb
 * (52px tall, full width) and a checkbox inheriting that grew into a grey
 * square beside the label. Purely decorative, so it is hidden from assistive
 * tech: the label's own text is the accessible name.
 */
export function CheckBox() {
  return (
    <span className="travel-check" aria-hidden>
      <svg viewBox="0 0 16 16" width="11" height="11" focusable="false" aria-hidden>
        <path
          d="M2.6 8.5 6.2 12l7.2-7.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** Labeled yes/no toggle (tri-state: unset shows as No). */
export function ToggleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={`travel-toggle${value ? " is-on" : ""}`}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <CheckBox />
      <span>{label}</span>
    </label>
  );
}

export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="travel-field-row">{children}</div>;
}

/** Labeled dropdown. */
export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="travel-field">
      <span className="travel-field-label">{label}</span>
      <select className="travel-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
