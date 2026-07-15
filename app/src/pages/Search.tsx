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
        <h1>Find a window</h1>
      </header>
      <input
        autoFocus
        placeholder="Type code, name, or window ID"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="unit-list">
        {(results.data ?? []).map((u) => (
          <li key={u.id} className="find-row">
            <Link to={`/w/${encodeURIComponent(u.window_id)}`}>
              <strong>{u.window_id}</strong>
            </Link>
            <span className="muted"> {u.window_types?.name}</span>
            <span className="big-address">
              {u.locations?.address ?? STATUS_LABELS[u.status]}
            </span>
          </li>
        ))}
        {query.trim().length >= 2 && results.data?.length === 0 && (
          <p className="muted">Nothing found.</p>
        )}
      </ul>
    </div>
  );
}
