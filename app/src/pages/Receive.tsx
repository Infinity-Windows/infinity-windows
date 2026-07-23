import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { listProjects, receiveWindow, suggestLocation } from "../lib/api";
import { WindowTypePicker } from "../components/WindowTypePicker";
import { downloadPdf, windowLabelsPdf } from "../lib/labels";
import type { WindowType, WindowUnit } from "../lib/types";

interface ReceivedRow {
  unit: WindowUnit;
  typeName: string;
  suggestedAddress: string | null;
}

export function Receive() {
  const queryClient = useQueryClient();
  const [typeId, setTypeId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<WindowType | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [received, setReceived] = useState<ReceivedRow[]>([]);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const receive = useMutation({
    mutationFn: async () => {
      if (!typeId) throw new Error("Pick a window type first");
      const unit = await receiveWindow(typeId, projectId || null);
      const suggestion = await suggestLocation(unit.id).catch(() => null);
      return {
        unit,
        typeName: selectedType?.name ?? "",
        suggestedAddress: suggestion?.address ?? null,
      };
    },
    onSuccess: (row) => {
      setReceived((prev) => [row, ...prev]);
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const printBatch = async () => {
    const bytes = await windowLabelsPdf(
      received.map((r) => ({
        window_id: r.unit.window_id,
        typeName: r.typeName,
        short_code: r.unit.short_code,
        serial: r.unit.serial,
        display_name: r.unit.display_name,
      })),
    );
    downloadPdf(bytes, "window-labels.pdf");
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Receive</h1>
          <p className="muted" style={{ margin: 0 }}>
            Create units into inventory and print labels.
          </p>
        </div>
        <Link to="/warehouse" className="back-chip" aria-label="Warehouse">‹</Link>
      </header>

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

      <button
        className="primary big"
        disabled={!typeId || receive.isPending}
        onClick={() => receive.mutate()}
      >
        {receive.isPending ? "Creating..." : "Receive 1 window"}
      </button>
      {receive.error && <p className="error">{String(receive.error)}</p>}

      {received.length > 0 && (
        <>
          <div className="row-between">
            <h2>This session ({received.length})</h2>
            <button className="button-like" onClick={printBatch}>Print labels</button>
          </div>
          <ul className="unit-list work-list">
            {received.map((r) => (
              <li key={r.unit.id} className="find-row">
                <Link to={`/w/${encodeURIComponent(r.unit.window_id)}`}>
                  <strong>{r.unit.window_id}</strong>
                </Link>
                {r.unit.short_code && (
                  <span className="short-code-chip"> {r.unit.short_code}</span>
                )}
                <span className="muted"> {r.typeName}</span>
                {r.suggestedAddress && (
                  <span className="suggest" style={{ marginLeft: "auto" }}>
                    put in {r.suggestedAddress}
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
