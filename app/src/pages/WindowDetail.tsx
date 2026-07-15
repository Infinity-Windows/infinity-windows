import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { Scanner } from "../components/Scanner";
import {
  getLocationByAddress,
  getMovements,
  getWindowByWindowId,
  installWindow,
  loadWindow,
  moveWindow,
  suggestLocation,
} from "../lib/api";
import { downloadPdf, windowLabelsPdf } from "../lib/labels";
import { STATUS_LABELS } from "../lib/types";

export function WindowDetail() {
  const { windowId = "" } = useParams();
  const queryClient = useQueryClient();
  const [moving, setMoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const unit = useQuery({
    queryKey: ["window", windowId],
    queryFn: () => getWindowByWindowId(windowId),
  });

  const suggestion = useQuery({
    queryKey: ["suggest", unit.data?.id],
    queryFn: () => suggestLocation(unit.data!.id),
    enabled: Boolean(unit.data?.id) && moving,
  });

  const movements = useQuery({
    queryKey: ["movements", unit.data?.id],
    queryFn: () => getMovements(unit.data!.id),
    enabled: Boolean(unit.data?.id),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["window", windowId] });
    queryClient.invalidateQueries({ queryKey: ["movements"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const moveTo = useMutation({
    mutationFn: async (address: string) => {
      const location = await getLocationByAddress(address);
      if (!location) throw new Error(`No slot with address ${address}`);
      return moveWindow(unit.data!.id, location.id);
    },
    onSuccess: () => {
      setMoving(false);
      setActionError(null);
      refresh();
    },
    onError: (e) => setActionError(String(e)),
  });

  const load = useMutation({
    mutationFn: () => loadWindow(unit.data!.id),
    onSuccess: refresh,
    onError: (e) => setActionError(String(e)),
  });

  const install = useMutation({
    mutationFn: () => installWindow(unit.data!.id),
    onSuccess: refresh,
    onError: (e) => setActionError(String(e)),
  });

  if (unit.isLoading) return <div className="page">Loading...</div>;
  if (!unit.data) {
    return (
      <div className="page">
        <p className="error">No window found with ID {windowId}.</p>
      </div>
    );
  }

  const w = unit.data;
  return (
    <div className="page">
      <header className="page-header">
        <h1>{w.window_id}</h1>
      </header>

      <div className="detail-card">
        <p>
          <strong>{w.window_types?.name}</strong>{" "}
          <span className="muted">({w.window_types?.type_code})</span>
        </p>
        <p>
          Status: <strong>{STATUS_LABELS[w.status]}</strong>
        </p>
        <p className="location-line">
          Location:{" "}
          <strong className="big-address">
            {w.locations?.address ?? "not in a slot"}
          </strong>
        </p>
        {w.projects && (
          <p>
            Job: <strong>{w.projects.job_code}</strong> — {w.projects.name}
          </p>
        )}
        {w.window_types?.difficulty_rating && (
          <p>
            Install difficulty: {"\u2605".repeat(w.window_types.difficulty_rating)}
          </p>
        )}
        {w.window_types?.tutorial_url && (
          <p>
            <a href={w.window_types.tutorial_url}>Install tutorial</a>
          </p>
        )}
      </div>

      {actionError && <p className="error">{actionError}</p>}

      {!moving ? (
        <div className="action-list">
          <button className="action-btn primary" onClick={() => setMoving(true)}>
            Move / put away
          </button>
          {w.project_id && w.status !== "loaded" && w.status !== "installed" && (
            <button className="action-btn" onClick={() => load.mutate()}>
              Load on truck for {w.projects?.job_code}
            </button>
          )}
          {(w.status === "loaded" || w.status === "staged") && (
            <button className="action-btn" onClick={() => install.mutate()}>
              Mark installed
            </button>
          )}
          <button
            className="action-btn"
            onClick={async () => {
              const bytes = await windowLabelsPdf([
                {
                  window_id: w.window_id,
                  typeName: w.window_types?.name ?? "",
                },
              ]);
              downloadPdf(bytes, `${w.window_id}.pdf`);
            }}
          >
            Reprint label
          </button>
        </div>
      ) : (
        <div>
          {suggestion.data && (
            <button
              className="action-btn primary"
              onClick={() => moveTo.mutate(suggestion.data!.address)}
            >
              Put in suggested slot: {suggestion.data.address}
            </button>
          )}
          <p className="scanner-hint">Or scan the destination slot label:</p>
          <Scanner
            onScan={(payload) => {
              if (payload.kind === "location") {
                moveTo.mutate(payload.address);
              } else {
                setActionError("That's a window label — scan a slot label.");
              }
            }}
          />
          <button className="link" onClick={() => setMoving(false)}>
            Cancel move
          </button>
        </div>
      )}

      <h2>History</h2>
      <ul className="history-list">
        {(movements.data ?? []).map((m) => (
          <li key={m.id}>
            <span className="muted">
              {new Date(m.created_at).toLocaleString()}
            </span>{" "}
            {m.event}
            {m.actor ? ` by ${m.actor}` : ""}
            {m.reason ? ` — ${m.reason}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
