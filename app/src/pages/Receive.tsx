import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listProjects, receiveWindow, suggestLocation } from "../lib/api";
import { WindowTypePicker } from "../components/WindowTypePicker";
import {
  allIdsSelected,
  clampReceiveCount,
  runBulkSequential,
  toggleAllIds,
  toggleId,
} from "../lib/bulk";
import { downloadPdf, windowLabelsPdf } from "../lib/labels";
import { plainSuggestion, type PutawaySuggestion } from "../lib/staging";
import { pushToast, toastError } from "../lib/toast";
import type { WindowType, WindowUnit } from "../lib/types";

interface ReceivedRow {
  unit: WindowUnit;
  typeName: string;
  suggestion: PutawaySuggestion;
}

export function Receive() {
  const queryClient = useQueryClient();
  const [typeId, setTypeId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<WindowType | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [qty, setQty] = useState(1);
  const [received, setReceived] = useState<ReceivedRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const createOne = async (): Promise<ReceivedRow> => {
    if (!typeId) throw new Error("Pick a window type first");
    const unit = await receiveWindow(typeId, projectId || null);
    // A failure to suggest must not lose the unit that was just received, but
    // it must not disappear either: a blank suggestion used to be the only
    // visible symptom of a job with no staging bay.
    const suggestion = await suggestLocation(unit.id, projectId || null).catch(
      () => plainSuggestion(null),
    );
    return { unit, typeName: selectedType?.name ?? "", suggestion };
  };

  const receive = useMutation({
    mutationFn: async () => {
      if (!typeId) throw new Error("Pick a window type first");
      const n = clampReceiveCount(qty);
      return runBulkSequential(n, () => createOne());
    },
    onSuccess: ({ successes, failures }) => {
      if (successes.length > 0) {
        // Newest first, matching the single-receive ordering.
        setReceived((prev) => [...[...successes].reverse(), ...prev]);
        queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        pushToast(
          `Received ${successes.length} window${successes.length === 1 ? "" : "s"}.`,
          "success",
        );
      }
      if (failures.length > 0) {
        toastError(
          failures[0].error,
          `Couldn't receive ${failures.length} of the windows. Please try again.`,
        );
      }
    },
  });

  const printRows = async (rows: ReceivedRow[], filename: string) => {
    if (rows.length === 0) return;
    const bytes = await windowLabelsPdf(
      rows.map((r) => ({
        window_id: r.unit.window_id,
        typeName: r.typeName,
        short_code: r.unit.short_code,
        serial: r.unit.serial,
        display_name: r.unit.display_name,
      })),
    );
    downloadPdf(bytes, filename);
  };

  const allIds = useMemo(() => received.map((r) => r.unit.id), [received]);
  const allSelected = allIdsSelected(allIds, selected);
  const selectedRows = received.filter((r) => selected.has(r.unit.id));

  const removeSelected = () => {
    setReceived((prev) => prev.filter((r) => !selected.has(r.unit.id)));
    setSelected(new Set());
  };

  const clampedQty = clampReceiveCount(qty);
  // The newest warning wins: it is about the units the foreman is holding.
  const stagingWarning = received.find((r) => r.suggestion.warning)?.suggestion
    .warning;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Receive extra stock</h1>
          <p className="muted" style={{ margin: 0 }}>
            Add unplanned / extra units into inventory and print labels.
          </p>
        </div>
        <Link to="/warehouse" className="back-chip" aria-label="Warehouse">‹</Link>
      </header>

      <div className="detail-card" style={{ marginBottom: 16 }}>
        <strong>Receiving a planned delivery instead?</strong>
        <p className="muted" style={{ margin: "4px 0 8px" }}>
          For windows that were pre-ordered for a job, use “Receive against the
          plan” on that job so each unit matches its expected ID.
        </p>
        <Link to="/projects" className="action-btn">
          Open a job to receive against the plan →
        </Link>
      </div>

      <label className="field-label">Window type</label>
      <WindowTypePicker
        value={typeId}
        onChange={(id, type) => {
          setTypeId(id || null);
          setSelectedType(type);
        }}
      />

      <label className="field-label">Sold to job (optional)</label>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">Extra stock (not for a job)</option>
        {(projects.data ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.job_code} — {p.name}
          </option>
        ))}
      </select>

      <label className="field-label">How many?</label>
      <div className="qty-stepper" role="group" aria-label="How many windows to receive">
        <button
          type="button"
          className="qty-btn"
          aria-label="One fewer"
          disabled={clampedQty <= 1 || receive.isPending}
          onClick={() => setQty((q) => clampReceiveCount(q - 1))}
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={50}
          value={qty}
          aria-label="Quantity"
          onChange={(e) => setQty(Number(e.target.value))}
          onBlur={() => setQty((q) => clampReceiveCount(q))}
        />
        <button
          type="button"
          className="qty-btn"
          aria-label="One more"
          disabled={clampedQty >= 50 || receive.isPending}
          onClick={() => setQty((q) => clampReceiveCount(q + 1))}
        >
          +
        </button>
      </div>

      <button
        className="primary big"
        disabled={!typeId || receive.isPending}
        onClick={() => receive.mutate()}
      >
        {receive.isPending
          ? "Creating..."
          : `Receive ${clampedQty} window${clampedQty === 1 ? "" : "s"}`}
      </button>
      {receive.error && <p className="error">{String(receive.error)}</p>}

      {stagingWarning && (
        <div className="sched-conflict-inline is-emphasized" role="alert">
          <div>
            <p style={{ margin: 0 }}>{stagingWarning}</p>
            {projectId && (
              <Link
                to={`/projects/${projectId}?tab=warehouse`}
                className="action-btn"
                style={{ marginTop: 8 }}
              >
                Open this job&apos;s Warehouse tab to fix it →
              </Link>
            )}
          </div>
        </div>
      )}

      {received.length > 0 && (
        <>
          <div className="row-between">
            <h2>This session ({received.length})</h2>
            <button
              className="button-like"
              onClick={() => printRows(received, "window-labels.pdf")}
            >
              Print labels
            </button>
          </div>

          <label
            style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}
          >
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected((s) => toggleAllIds(allIds, s))}
            />
            Select all ({received.length})
          </label>

          {selectedRows.length > 0 && (
            <div className="action-list">
              <button
                className="action-btn"
                onClick={() =>
                  printRows(selectedRows, "window-labels-selected.pdf")
                }
              >
                Print labels for selected ({selectedRows.length})
              </button>
              <button
                className="action-btn danger-outline"
                onClick={removeSelected}
              >
                Remove selected ({selectedRows.length})
              </button>
            </div>
          )}

          <ul className="unit-list work-list">
            {received.map((r) => (
              <li key={r.unit.id} className="find-row">
                <input
                  type="checkbox"
                  aria-label={`Select ${r.unit.window_id}`}
                  checked={selected.has(r.unit.id)}
                  onChange={() => setSelected((s) => toggleId(s, r.unit.id))}
                  style={{ marginRight: 8 }}
                />
                <Link to={`/w/${encodeURIComponent(r.unit.window_id)}`}>
                  <strong>{r.unit.window_id}</strong>
                </Link>
                {r.unit.short_code && (
                  <span className="short-code-chip"> {r.unit.short_code}</span>
                )}
                <span className="muted"> {r.typeName}</span>
                {r.suggestion.location && (
                  <span
                    className={r.suggestion.warning ? "warn-text" : "suggest"}
                    style={{ marginLeft: "auto" }}
                  >
                    put in {r.suggestion.location.address}
                    {r.suggestion.warning ? " (shared shelf)" : ""}
                  </span>
                )}
                {r.suggestion.missingBay && (
                  <span className="warn-text" style={{ marginLeft: "auto" }}>
                    no staging bay
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
