import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { listWindowTypes } from "../lib/api";
import type { WindowType } from "../lib/types";

/**
 * Shared window-type catalog query. One React Query key (`["windowTypes"]`) so
 * Receive, Catalog import, and Opening review all read the same cached list
 * (Receive previously used a separate `["types"]` key and re-fetched).
 */
export function useWindowTypes() {
  return useQuery({ queryKey: ["windowTypes"], queryFn: listWindowTypes });
}

interface WindowTypePickerProps {
  value: string | null;
  onChange: (id: string, type: WindowType | null) => void;
  /**
   * "list" = searchable button list (warehouse Receive flow);
   * "select" = compact native dropdown (per-row opening review).
   */
  variant?: "list" | "select";
  placeholder?: string;
  /** Blank leading option for the select variant. */
  blankLabel?: string;
  selectClassName?: string;
}

/**
 * Pick a window type from the shared catalog. Extracted from the near-identical
 * search-and-pick UIs that lived in Receive and Opening review so the two stay
 * in lockstep and share one cached query.
 */
export function WindowTypePicker({
  value,
  onChange,
  variant = "list",
  placeholder = "Search types (code or name)",
  blankLabel = "— pick type —",
  selectClassName,
}: WindowTypePickerProps) {
  const types = useWindowTypes();
  const [query, setQuery] = useState("");
  const all = useMemo(() => types.data ?? [], [types.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (t) =>
        t.type_code.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q),
    );
  }, [all, query]);

  if (variant === "select") {
    return (
      <select
        className={selectClassName}
        value={value ?? ""}
        onChange={(e) => {
          const id = e.target.value;
          onChange(id, all.find((t) => t.id === id) ?? null);
        }}
      >
        <option value="">{blankLabel}</option>
        {all.map((t) => (
          <option key={t.id} value={t.id}>
            {t.type_code} {t.name}
          </option>
        ))}
      </select>
    );
  }

  return (
    <>
      <input
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="pick-box">
        {filtered.map((t) => (
          <button
            key={t.id}
            type="button"
            className={t.id === value ? "pick-row selected" : "pick-row"}
            onClick={() => onChange(t.id, t)}
          >
            <strong>{t.type_code}</strong> {t.name}
          </button>
        ))}
        {filtered.length === 0 && <p className="muted">No matching types.</p>}
      </div>
    </>
  );
}
