import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { importWindowTypes, listWindowTypes } from "../lib/api";
import { parseCatalogCsv, type CatalogCsvRow } from "../lib/catalogCsv";

const TEMPLATE = `type_code,name,category,width_in,height_in,difficulty_rating,tutorial_url,notes
CAS3050,Casement 30x50,casement,30,50,3,,
DH2846,Double Hung 28x46,double-hung,28,46,2,,
`;

export function CatalogImport() {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<CatalogCsvRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const types = useQuery({ queryKey: ["windowTypes"], queryFn: listWindowTypes });

  const importRows = useMutation({
    mutationFn: () => importWindowTypes(preview),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["windowTypes"] });
      setMessage(
        `Imported ${result.total}: ${result.inserted} new, ${result.updated} updated.`,
      );
      setPreview([]);
      setParseErrors([]);
    },
    onError: (e) => setMessage(String(e)),
  });

  const onFile = async (file: File) => {
    setMessage(null);
    const text = await file.text();
    const { rows, errors } = parseCatalogCsv(text);
    setPreview(rows);
    setParseErrors(errors);
    if (rows.length === 0) {
      setMessage("No valid rows to import.");
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Catalog import</h1>
        <Link to="/" className="button-like">
          Home
        </Link>
      </header>
      <p className="muted">
        Load the real ~100 window types from CSV (include width_in/height_in —
        the fit check needs them). Upserts by <code>type_code</code>;
        synthesized tips on existing types are kept.
      </p>
      <p className="muted">
        Currently in catalog: <strong>{types.data?.length ?? "—"}</strong> types
      </p>

      <div className="action-list">
        <label className="action-btn primary" style={{ cursor: "pointer" }}>
          Choose CSV
          <input
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
              e.target.value = "";
            }}
          />
        </label>
        <button
          className="action-btn"
          onClick={() => {
            const blob = new Blob([TEMPLATE], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "window-types-template.csv";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download CSV template
        </button>
      </div>

      {message && (
        <p className={message.startsWith("Imported") ? "ok" : "error"}>{message}</p>
      )}
      {parseErrors.length > 0 && (
        <ul className="unit-list">
          {parseErrors.slice(0, 8).map((e) => (
            <li key={e} className="warn-text">
              {e}
            </li>
          ))}
        </ul>
      )}

      {preview.length > 0 && (
        <>
          <h2>Preview ({preview.length})</h2>
          <ul className="unit-list">
            {preview.slice(0, 20).map((r) => (
              <li key={r.type_code}>
                <strong>{r.type_code}</strong> — {r.name}
                {r.category && <span className="muted"> · {r.category}</span>}
              </li>
            ))}
            {preview.length > 20 && (
              <p className="muted">…and {preview.length - 20} more</p>
            )}
          </ul>
          <button
            className="primary big"
            disabled={importRows.isPending}
            onClick={() => importRows.mutate()}
          >
            {importRows.isPending
              ? "Importing…"
              : `Import ${preview.length} types`}
          </button>
        </>
      )}
    </div>
  );
}
