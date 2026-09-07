// One shape for a label/value pair (kit item G, S6): a small caption over —
// or, `inline`, beside — its value. Pulled out of the Tomorrow strip, which
// repeats it for "Starts" and "Truck"; this file owns that shape alone, the
// same rule ListRow and StatusChip hold for theirs. Not a form field — no
// input here, just a labelled read.
import type { ReactNode } from "react";

export function Field({
  label,
  value,
  inline = false,
}: {
  label: string;
  value: ReactNode;
  /** Label and value share one line (a strip's meta row) instead of
   * stacking (a card's spec grid). */
  inline?: boolean;
}) {
  return (
    <span className={`kit-field${inline ? " kit-field--inline" : ""}`}>
      <span className="kit-field-label">{label}</span>
      <span className="kit-field-value">{value}</span>
    </span>
  );
}
