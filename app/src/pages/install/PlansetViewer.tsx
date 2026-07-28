import { useEffect, useRef, useState } from "react";
import { downloadPlanset } from "../../lib/install/api";
import { formatApiError } from "../../lib/install/errors";
import type { Planset } from "../../lib/install/types";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

function fileName(ps: Planset): string {
  return ps.storage_path.split("/").pop() ?? ps.storage_path;
}

interface PlansetViewerProps {
  planset: Planset;
  onClose: () => void;
}

/** In-app page-by-page PDF viewer for an uploaded planset. */
export function PlansetViewer({ planset, onClose }: PlansetViewerProps) {
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const docRef = useRef<PDFDocumentProxy | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setImageUrl(null);
    setPage(1);
    (async () => {
      try {
        const { loadPdf, renderPageImage } = await import(
          "../../lib/install/pdf"
        );
        const buf = await downloadPlanset(planset);
        const doc = await loadPdf(buf);
        if (cancelled) return;
        docRef.current = doc;
        setPageCount(doc.numPages);
        const img = await renderPageImage(doc, 1);
        if (!cancelled) setImageUrl(img.dataUrl);
      } catch (e) {
        if (!cancelled) setError(formatApiError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      docRef.current = null;
    };
  }, [planset.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const doc = docRef.current;
    if (!doc || page < 1 || page > doc.numPages) return;
    let cancelled = false;
    import("../../lib/install/pdf")
      .then(({ renderPageImage }) => renderPageImage(doc, page))
      .then((img) => {
        if (!cancelled) setImageUrl(img.dataUrl);
      })
      .catch((e) => {
        if (!cancelled) setError(formatApiError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [page]);

  return (
    <div className="planset-viewer" role="dialog" aria-label="Planset viewer">
      <header className="page-header">
        <div>
          <p className="home-greeting">
            {planset.kind === "specs" ? "Specs" : "Building plan"}
          </p>
          <h1 style={{ fontSize: 18 }}>{fileName(planset)}</h1>
        </div>
        <button type="button" className="back-chip" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {loading && <p className="muted">Loading planset…</p>}
      {error && <p className="error">{error}</p>}

      {imageUrl && (
        <div className="plan-sheet">
          <div className="plan-map">
            <img src={imageUrl} alt={`${fileName(planset)} page ${page}`} />
          </div>
        </div>
      )}

      {pageCount > 1 && (
        <nav className="hub-tabs page-switch" aria-label="Plan pages">
          <button
            type="button"
            className="hub-tab"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ◀
          </button>
          <span className="hub-tab active" style={{ pointerEvents: "none" }}>
            Page {page} / {pageCount}
          </span>
          <button
            type="button"
            className="hub-tab"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          >
            ▶
          </button>
        </nav>
      )}
    </div>
  );
}
