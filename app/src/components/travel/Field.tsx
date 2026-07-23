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
    <label className="travel-toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
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
