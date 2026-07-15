import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  listProjects,
  listWindowTypes,
  receiveWindow,
  suggestLocation,
} from "../lib/api";
import { downloadPdf, windowLabelsPdf } from "../lib/labels";
import type { WindowUnit } from "../lib/types";

interface ReceivedRow {
  unit: WindowUnit;
  typeName: string;
  suggestedAddress: string | null;
}

export function Receive() {
  const queryClient = useQueryClient();
  const [typeQuery, setTypeQuery] = useState("");
  const [typeId, setTypeId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [received, setReceived] = useState<ReceivedRow[]>([]);

  const types = useQuery({ queryKey: ["types"], queryFn: listWindowTypes });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const filteredTypes = useMemo(() => {
    const q = typeQuery.trim().toLowerCase();
    const all = types.data ?? [];
    if (!q) return all;
    return all.filter(
      (t) =>
        t.type_code.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q),
    );
  }, [types.data, typeQuery]);

  const selectedType = types.data?.find((t) => t.id === typeId) ?? null;

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
      })),
    );
    downloadPdf(bytes, "window-labels.pdf");
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Receive</h1>
      </header>

      <label className="field-label">Window type</label>
      <input
        placeholder="Search types (code or name)"
        value={typeQuery}
        onChange={(e) => setTypeQuery(e.target.value)}
      />
      <div className="pick-box">
        {filteredTypes.map((t) => (
          <button
            key={t.id}
            className={t.id === typeId ? "pick-row selected" : "pick-row"}
            onClick={() => setTypeId(t.id)}
          >
            <strong>{t.type_code}</strong> {t.name}
          </button>
        ))}
        {filteredTypes.length === 0 && (
          <p className="muted">No matching types.</p>
        )}
      </div>

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
            <button onClick={printBatch}>Print labels</button>
          </div>
          <ul className="unit-list">
            {received.map((r) => (
              <li key={r.unit.id}>
                <Link to={`/w/${encodeURIComponent(r.unit.window_id)}`}>
                  <strong>{r.unit.window_id}</strong>
                </Link>
                <span className="muted"> {r.typeName}</span>
                {r.suggestedAddress && (
                  <span className="suggest"> put in {r.suggestedAddress}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
