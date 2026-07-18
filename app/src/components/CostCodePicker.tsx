import { useQuery } from "@tanstack/react-query";
import { listCostCodes, type CostCode } from "../lib/timeclock";

/**
 * Reusable picker for the global cost-code library. Any surface that needs a
 * cost code (clock-in sheet, timecard, edits) can drop this in and get a
 * consistent list sourced from the same active library.
 *
 * - `chips` (default): tap-to-select code chips — best for phone / bottom sheet.
 * - `select`: a native dropdown — best for dense forms and desktop.
 *
 * Codes are fetched from the shared ["costCodes"] query (active only) unless a
 * `codes` prop is supplied, so callers that already have the list don't refetch.
 */
export function CostCodePicker({
  value,
  onChange,
  codes,
  variant = "chips",
  disabled = false,
  showLabel = false,
  id,
  ariaLabel = "Cost code",
}: {
  value: string | null;
  onChange: (costCodeId: string) => void;
  codes?: CostCode[];
  variant?: "chips" | "select";
  disabled?: boolean;
  /** Chips: show the name beside the code. Select always shows both. */
  showLabel?: boolean;
  id?: string;
  ariaLabel?: string;
}) {
  const query = useQuery({
    queryKey: ["costCodes"],
    queryFn: listCostCodes,
    enabled: codes === undefined,
  });
  const list = codes ?? query.data ?? [];

  if (codes === undefined && query.isLoading) {
    return <p className="muted">Loading cost codes…</p>;
  }

  if (list.length === 0) {
    return <p className="muted">No cost codes set up yet.</p>;
  }

  if (variant === "select") {
    return (
      <select
        id={id}
        aria-label={ariaLabel}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">— pick a code —</option>
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} · {c.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="clock-chip-row wrap" role="group" aria-label={ariaLabel}>
      {list.map((c) => (
        <button
          key={c.id}
          type="button"
          className={value === c.id ? "clock-chip current" : "clock-chip"}
          disabled={disabled}
          aria-pressed={value === c.id}
          onClick={() => onChange(c.id)}
          title={c.description ?? c.label}
        >
          {c.code}
          {showLabel ? ` · ${c.label}` : ""}
        </button>
      ))}
    </div>
  );
}
