import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listProjects } from "../../lib/api";
import {
  downloadPlanset,
  listOpenings,
  listPlansets,
  updateOpening,
} from "../../lib/install/api";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import {
  OPENING_STATUS_COLORS,
  type ProjectOpening,
} from "../../lib/install/types";

interface PageImage {
  dataUrl: string;
  width: number;
  height: number;
}

type PlanFilter = "all" | "open" | "windows" | "doors" | "done";

const FILTERS: { id: PlanFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "windows", label: "Windows" },
  { id: "doors", label: "Doors" },
  { id: "done", label: "Done" },
];

function unitKind(o: ProjectOpening): "door" | "window" {
  return (o.window_types?.category ?? "").toLowerCase().includes("door")
    ? "door"
    : "window";
}

export function ProjectMap({ embedded = false }: { embedded?: boolean }) {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [image, setImage] = useState<PageImage | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [placingId, setPlacingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PlanFilter>("all");
  const docRef = useRef<PDFDocumentProxy | null>(null);

  const matchesFilter = (o: ProjectOpening): boolean => {
    switch (filter) {
      case "open":
        return o.status !== "installed";
      case "done":
        return o.status === "installed";
      case "windows":
        return unitKind(o) === "window";
      case "doors":
        return unitKind(o) === "door";
      default:
        return true;
    }
  };

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
  const filtered = all.filter(matchesFilter);
  const onThisPage = filtered.filter(
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
    `${o.opening_code}${o.window_types ? ` ${o.window_types.type_code}` : ""}${
      o.assignee ? ` — ${o.assignee.display_name}` : ""
    }`;

  const initials = (name?: string | null) =>
    name
      ? name
          .split(/[\s._-]+/)
          .map((s) => s[0])
          .join("")
          .slice(0, 2)
          .toUpperCase()
      : "";

  const openOpening = (openingId: string) =>
    navigate(`/projects/${projectId}/opening/${openingId}`);

  const body = (
    <>
      {!embedded && (
        <header className="page-header">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Link to={`/projects/${projectId}`} className="back-chip" aria-label="Back">
              ‹
            </Link>
            <h1>{project?.job_code ?? "Job"} map</h1>
          </div>
          <div className="row-gap">
            <Link to={`/projects/${projectId}/upload`} className="button-like">
              Planset
            </Link>
            <Link to={`/projects/${projectId}/review`} className="button-like">
              Openings
            </Link>
          </div>
        </header>
      )}
      <p className="muted">
        {installed}/{all.length} installed
        {unplaced.length > 0 && ` — ${unplaced.length} pins to place`}
      </p>

      <nav className="plan-filters" aria-label="Filter openings">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={filter === f.id ? "chip active" : "chip"}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </nav>

      {embedded && (
        <div className="row-gap" style={{ marginBottom: 10 }}>
          <Link to={`/projects/${projectId}/upload`} className="button-like">
            Planset
          </Link>
          <Link to={`/projects/${projectId}/review`} className="button-like">
            Openings
          </Link>
        </div>
      )}

      {mapError && <p className="error">{mapError}</p>}

      {!pdfPlanset && (
        <p className="muted">
          No PDF planset yet.{" "}
          <Link to={`/projects/${projectId}/upload`}>Upload one</Link> to get a
          map. Openings below still work without it.
        </p>
      )}

      {placingId && (
        <p className="scanner-hint">
          Tap the plan where opening{" "}
          <strong>{all.find((o) => o.id === placingId)?.opening_code}</strong>{" "}
          goes.{" "}
          <button className="link" onClick={() => setPlacingId(null)}>
            Cancel
          </button>
        </p>
      )}

      {image && (
        <div className="plan-sheet">
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
                    const rect = (
                      e.currentTarget.parentElement as HTMLElement
                    ).getBoundingClientRect();
                    placePin.mutate({
                      id: placingId,
                      x: (e.clientX - rect.left) / rect.width,
                      y: (e.clientY - rect.top) / rect.height,
                    });
                    return;
                  }
                  openOpening(o.id);
                }}
              >
                {o.assignee ? initials(o.assignee.display_name) : o.opening_code}
              </button>
            ))}
          </div>
        </div>
      )}

      {pageCount > 1 && (
        <nav className="hub-tabs page-switch" aria-label="Plan pages">
          <button
            type="button"
            className="hub-tab"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
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
            onClick={() => setPage(page + 1)}
          >
            ▶
          </button>
        </nav>
      )}

      <div className="map-legend muted">
        <span>
          <i style={{ background: OPENING_STATUS_COLORS.planned }} /> planned
        </span>
        <span>
          <i style={{ background: OPENING_STATUS_COLORS.assigned }} /> assigned
        </span>
        <span>
          <i style={{ background: OPENING_STATUS_COLORS.installed }} /> installed
        </span>
      </div>

      {unplaced.length > 0 && (
        <>
          <h2>Needs a pin ({unplaced.length})</h2>
          <ul className="unit-list work-list">
            {unplaced.map((o) => (
              <li key={o.id} className="find-row">
                <Link to={`/projects/${projectId}/opening/${o.id}`}>
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

      <h2>
        {filter === "all" ? "All openings" : FILTERS.find((f) => f.id === filter)?.label}{" "}
        ({filtered.length})
      </h2>
      <ul className="unit-list work-list">
        {filtered.map((o) => (
          <li key={o.id} className="find-row">
            <span
              className="unit-dot"
              aria-hidden
              style={{ background: unitKind(o) === "door" ? "var(--ok)" : "var(--info)" }}
            />
            <Link to={`/projects/${projectId}/opening/${o.id}`}>
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
        {filtered.length === 0 && all.length > 0 && (
          <p className="muted">No openings match this filter.</p>
        )}
        {all.length === 0 && (
          <p className="muted">
            No openings yet —{" "}
            <Link to={`/projects/${projectId}/upload`}>upload a planset</Link> or{" "}
            <Link to={`/projects/${projectId}/review`}>add them by hand</Link>.
          </p>
        )}
      </ul>
    </>
  );

  if (embedded) return <div>{body}</div>;
  return <div className="page">{body}</div>;
}
