import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ScanLine } from "lucide-react";
import { searchUnits } from "../lib/api";
import { STATUS_LABELS } from "../lib/types";

/**
 * Shared unit locator: search inventory by window ID / type code and jump to a
 * unit, with a quick Scan shortcut. Single source for the Warehouse hub's
 * "Locate" section (previously duplicated by the standalone Search page).
 */
export function UnitSearch({
  autoFocus = false,
  placeholder = "Locate: unit ID or type code…",
  limit,
}: {
  autoFocus?: boolean;
  placeholder?: string;
  /** Cap the number of rows shown (the hub keeps the list compact). */
  limit?: number;
}) {
  const [query, setQuery] = useState("");
  const results = useQuery({
    queryKey: ["search", query],
    queryFn: () => searchUnits(query),
    enabled: query.trim().length >= 2,
  });

  const rows = limit ? (results.data ?? []).slice(0, limit) : results.data ?? [];

  return (
    <>
      <div className="locate-search">
        <input
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Link to="/scan" className="locate-go" aria-label="Scan">
          <ScanLine size={20} />
        </Link>
      </div>

      {query.trim().length >= 2 && (
        <ul className="unit-list work-list" style={{ marginTop: 4 }}>
          {rows.map((u) => (
            <li key={u.id} className="find-row">
              <span className="unit-badge" aria-hidden>
                {(u.window_types?.type_code ?? "?").slice(0, 3)}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <Link to={`/w/${encodeURIComponent(u.window_id)}`}>
                  <strong>{u.window_id}</strong>
                </Link>
                <div className="muted" style={{ fontSize: 12 }}>
                  {u.window_types?.name ?? u.window_types?.type_code}
                </div>
              </div>
              <span className="big-address">
                {u.locations?.address ?? STATUS_LABELS[u.status]}
              </span>
            </li>
          ))}
          {results.data?.length === 0 && <p className="muted">Nothing found.</p>}
        </ul>
      )}
    </>
  );
}
