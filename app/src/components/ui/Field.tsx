import type { ReactNode } from "react";

/**
 * A labeled slot for one control or one fact — the `field-label` + input
 * pattern repeated by hand across every install form, given a name so new
 * screens can reach for it instead of retyping the label markup. Existing
 * `field-label` spans are left exactly as they are; this is additive, not a
 * migration. See ListRow.tsx for why this lives here instead of importing
 * S6's own kit.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="ui-field">
      <span className="ui-field-label">{label}</span>
      {children}
      {hint && <span className="ui-field-hint">{hint}</span>}
    </label>
  );
}
