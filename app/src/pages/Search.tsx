import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { searchUnits } from "../lib/api";
import { STATUS_LABELS } from "../lib/types";

export function Search() {
  const [query, setQuery] = useState("");

  const results = useQuery({
    queryKey: ["search", query],
    queryFn: () => searchUnits(query),
    enabled: query.trim().length >= 2,
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Locate</h1>
          <p className="muted" style={{ margin: 0 }}>
            Find any unit by type code, name, or window ID.
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">‹</Link>
      </header>

      <div className="locate-search">
        <input
          autoFocus
          placeholder="Where is W-… or type code?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="locate-go" aria-label="Search" tabIndex={-1}>
          →
        </button>
      </div>

      <Link to="/scan" className="scan-cta">
        Scan unit QR
      </Link>

      <h2>Results</h2>
      <ul className="unit-list work-list">
        {(results.data ?? []).map((u) => (
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
        {query.trim().length >= 2 && results.data?.length === 0 && (
          <p className="muted">Nothing found.</p>
        )}
        {query.trim().length < 2 && (
          <p className="muted">Type at least 2 characters to search.</p>
        )}
      </ul>
    </div>
  );
}
