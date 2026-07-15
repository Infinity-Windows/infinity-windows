import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listProjects } from "../../lib/api";
import { downloadPlanset, listOpenings, listPlansets, updateOpening } from "../../lib/install/api";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { OPENING_STATUS_COLORS, type ProjectOpening } from "../../lib/install/types";

interface PageImage {
  dataUrl: string;
  width: number;
  height: number;
}

export function ProjectMap() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [image, setImage] = useState<PageImage | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [placingId, setPlacingId] = useState<string | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const project = projects.data?.find((p) => p.id === projectId);
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });
  const plansets = useQuery({
    queryKey: ["plansets", projectId],
    queryFn: () => listPlansets(projectId),
  });

  const pdfPlanset = (plansets.data ?? []).find(
    (ps) => ps.source_format === "pdf" || ps.converted_pdf_path,
  );

  useEffect(() => {
    if (!pdfPlanset) return;
    let cancelled = false;
    (async () => {
      try {
        const { loadPdf, renderPageImage } = await import("../../lib/install/pdf");
        const buf = await downloadPlanset(pdfPlanset);
        const doc = await loadPdf(buf);
        if (cancelled) return;
        docRef.current = doc;
        setPageCount(doc.numPages);
        setImage(await renderPageImage(doc, 1));
      } catch (e) {
        if (!cancelled) setMapError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfPlanset?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const doc = docRef.current;
    if (!doc || page < 1 || page > doc.numPages) return;
    let cancelled = false;
    import("../../lib/install/pdf")
      .then(({ renderPageImage }) => renderPageImage(doc, page))
      .then((img) => !cancelled && setImage(img))
      .catch((e) => !cancelled && setMapError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [page]);

  const placePin = useMutation({
    mutationFn: (args: { id: string; x: number; y: number }) =>
      updateOpening(args.id, {
        pin_x: Math.round(args.x * 1000) / 1000,
        pin_y: Math.round(args.y * 1000) / 1000,
        page_number: page,
      }),
    onSuccess: () => {
      setPlacingId(null);
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    },
    onError: (e) => setMapError(String(e)),
  });

  const all = openings.data ?? [];
  const onThisPage = all.filter(
    (o) => o.pin_x !== null && o.pin_y !== null && o.page_number === page,
  );
  const unplaced = all.filter((o) => o.pin_x === null || o.pin_y === null);
  const installed = all.filter((o) => o.status === "installed").length;

  const handleMapClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!placingId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    placePin.mutate({
      id: placingId,
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    });
  };

  const pinTitle = (o: ProjectOpening) =>
    `${o.opening_code}${o.window_types ? ` ${o.window_types.type_code}` : ""}`;

  return (
    <div className="page">
      <header className="page-header">
        <h1>{project?.job_code ?? "Job"} map</h1>
        <div className="row-gap">
          <Link to={`/install/${projectId}/upload`} className="button-like">
            Planset
          </Link>
          <Link to={`/install/${projectId}/review`} className="button-like">
            Openings
          </Link>
        </div>
      </header>
      <p className="muted">
        {installed}/{all.length} installed
        {unplaced.length > 0 && ` — ${unplaced.length} pins to place`}
      </p>

      {mapError && <p className="error">{mapError}</p>}

      {!pdfPlanset && (
        <p className="muted">
          No PDF planset yet.{" "}
          <Link to={`/install/${projectId}/upload`}>Upload one</Link> to get a
          map. Openings below still work without it.
        </p>
      )}

      {placingId && (
        <p className="scanner-hint">
          Tap the plan where opening{" "}
          <strong>
            {all.find((o) => o.id === placingId)?.opening_code}
          </strong>{" "}
          goes. <button className="link" onClick={() => setPlacingId(null)}>Cancel</button>
        </p>
      )}

      {image && (
        <div
          className={placingId ? "plan-map placing" : "plan-map"}
          onClick={handleMapClick}
        >
          <img src={image.dataUrl} alt={`Plan page ${page}`} />
          {onThisPage.map((o) => (
            <button
              key={o.id}
              className="map-pin"
              style={{
                left: `${(o.pin_x ?? 0) * 100}%`,
                top: `${(o.pin_y ?? 0) * 100}%`,
                background: OPENING_STATUS_COLORS[o.status],
              }}
              title={pinTitle(o)}
              onClick={(e) => {
                e.stopPropagation();
                if (placingId) {
                  // Re-placing onto an existing pin spot still counts as a map tap.
                  const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                  placePin.mutate({
                    id: placingId,
                    x: (e.clientX - rect.left) / rect.width,
                    y: (e.clientY - rect.top) / rect.height,
                  });
                  return;
                }
                navigate(`/install/${projectId}/opening/${o.id}`);
              }}
            >
              {o.opening_code}
            </button>
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="page-switch">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ◀
          </button>
          <span className="muted">
            Page {page} / {pageCount}
          </span>
          <button disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
            ▶
          </button>
        </div>
      )}

      <div className="map-legend muted">
        <span><i style={{ background: OPENING_STATUS_COLORS.planned }} /> planned</span>
        <span><i style={{ background: OPENING_STATUS_COLORS.assigned }} /> assigned</span>
        <span><i style={{ background: OPENING_STATUS_COLORS.installed }} /> installed</span>
      </div>

      {unplaced.length > 0 && (
        <>
          <h2>Needs a pin ({unplaced.length})</h2>
          <ul className="unit-list">
            {unplaced.map((o) => (
              <li key={o.id} className="find-row">
                <Link to={`/install/${projectId}/opening/${o.id}`}>
                  <strong>{o.opening_code}</strong>
                </Link>
                <span className="muted">
                  {o.window_types?.type_code ?? "type?"} {o.label ?? ""}
                </span>
                {image && (
                  <button
                    className="link"
                    style={{ marginLeft: "auto" }}
                    onClick={() => setPlacingId(o.id)}
                  >
                    Place pin
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>All openings ({all.length})</h2>
      <ul className="unit-list">
        {all.map((o) => (
          <li key={o.id} className="find-row">
            <Link to={`/install/${projectId}/opening/${o.id}`}>
              <strong>{o.opening_code}</strong>
            </Link>
            <span className="muted">
              {o.window_types?.type_code ?? "type?"} {o.label ?? ""}
            </span>
            <span
              className="big-address"
              style={{ color: OPENING_STATUS_COLORS[o.status] }}
            >
              {o.status}
            </span>
          </li>
        ))}
        {all.length === 0 && (
          <p className="muted">
            No openings yet —{" "}
            <Link to={`/install/${projectId}/upload`}>upload a planset</Link> or{" "}
            <Link to={`/install/${projectId}/review`}>add them by hand</Link>.
          </p>
        )}
      </ul>
    </div>
  );
}
