import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listProjects } from "../../lib/api";
import {
  downloadPlanset,
  listOpenings,
  listPlansets,
  listVoidedInstallOpeningIds,
  undoInstall,
  updateOpening,
} from "../../lib/install/api";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import {
  isForemanPlus,
  OPENING_KIND_COLORS,
  OPENING_STATUS_COLORS,
  openingMarkLabel,
  type ProjectOpening,
} from "../../lib/install/types";
import {
  extractCadDetailPages,
  findFloorPlanPages,
  type CadDetailPage,
} from "../../lib/install/planDetails";

/** Distinct ring for an opening whose install was undone (history preserved). */
const VOIDED_RING_COLOR = "#ef4444";

interface PageImage {
  dataUrl: string;
  width: number;
  height: number;
}

type PlanFilter = "all" | "open" | "windows" | "doors" | "done";
type DrawingView = "floor" | "details";

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
  const [view, setView] = useState<DrawingView>("floor");
  const [floorPages, setFloorPages] = useState<number[]>([]);
  const [buildingPageCount, setBuildingPageCount] = useState(0);
  const [specsPageCount, setSpecsPageCount] = useState(0);
  const [details, setDetails] = useState<CadDetailPage[]>([]);
  const [image, setImage] = useState<PageImage | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [placingId, setPlacingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PlanFilter>("all");
  const buildingDocRef = useRef<PDFDocumentProxy | null>(null);
  const specsDocRef = useRef<PDFDocumentProxy | null>(null);
  const [docsReady, setDocsReady] = useState(0);

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
  const { effectiveRole } = useEffectiveRole();
  // Failed/undone-install markers are foreman+ only. Installers never see the
  // voided ring, legend, or "redo needed" state; the query is also gated so the
  // data is never fetched for a non-foreman (faithful under view-as preview too).
  const isLead = isForemanPlus(effectiveRole);
  const voided = useQuery({
    queryKey: ["voidedOpenings", projectId, isLead],
    queryFn: () => listVoidedInstallOpeningIds(projectId, isLead),
    enabled: isLead,
  });
  const voidedIds = isLead ? voided.data ?? new Set<string>() : new Set<string>();

  const undo = useMutation({
    mutationFn: (args: { openingId: string; reason: string | null }) =>
      undoInstall(args.openingId, args.reason ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
      queryClient.invalidateQueries({ queryKey: ["voidedOpenings", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projectUnits", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projectExceptions", projectId] });
    },
    onError: (e) => setMapError(String(e)),
  });

  const handleUndo = (o: ProjectOpening) => {
    const reason = window.prompt(
      `Undo the install on ${o.opening_code}? The install record is kept for review.\n\nReason (optional):`,
    );
    if (reason === null) return; // cancelled
    undo.mutate({ openingId: o.id, reason: reason.trim() || null });
  };

  const buildingPdf = (plansets.data ?? []).find(
    (ps) => (ps.kind ?? "building") === "building" && ps.source_format === "pdf",
  );
  const specsPdf = (plansets.data ?? []).find(
    (ps) => ps.kind === "specs" && ps.source_format === "pdf",
  );

  useEffect(() => {
    if (!buildingPdf && !specsPdf) return;
    let cancelled = false;
    (async () => {
      try {
        const { extractAllText, loadPdf } = await import("../../lib/install/pdf");
        let initialPage = 1;

        if (buildingPdf) {
          const buildingDoc = await loadPdf(await downloadPlanset(buildingPdf));
          const buildingText = await extractAllText(buildingDoc);
          if (cancelled) return;
          buildingDocRef.current = buildingDoc;
          setBuildingPageCount(buildingDoc.numPages);
          const detectedFloorPages = findFloorPlanPages(buildingText);
          setFloorPages(detectedFloorPages);
          initialPage = detectedFloorPages[0] ?? 1;
        }

        if (specsPdf) {
          const specsDoc = await loadPdf(await downloadPlanset(specsPdf));
          const specsText = await extractAllText(specsDoc);
          if (cancelled) return;
          specsDocRef.current = specsDoc;
          setSpecsPageCount(specsDoc.numPages);
          setDetails(extractCadDetailPages(specsText));
        }

        if (!buildingPdf && specsPdf) {
          setView("details");
          initialPage = 1;
        }
        setPage(initialPage);
        setDocsReady((ready) => ready + 1);
      } catch (e) {
        if (!cancelled) setMapError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildingPdf?.id, specsPdf?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const doc = view === "floor" ? buildingDocRef.current : specsDocRef.current;
    if (!doc || page < 1 || page > doc.numPages) return;
    let cancelled = false;
    setImage(null);
    import("../../lib/install/pdf")
      .then(({ renderPageImage }) => renderPageImage(doc, page))
      .then((img) => !cancelled && setImage(img))
      .catch((e) => !cancelled && setMapError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [page, view, docsReady]);

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
  const detailPages = details.map((detail) => detail.pageNumber);
  const visiblePages =
    view === "floor"
      ? floorPages.length > 0
        ? floorPages
        : Array.from({ length: buildingPageCount }, (_, index) => index + 1)
      : detailPages.length > 0
        ? detailPages
        : Array.from({ length: specsPageCount }, (_, index) => index + 1);
  const pageIndex = Math.max(0, visiblePages.indexOf(page));
  const activePlanset = view === "floor" ? buildingPdf : specsPdf;
  const activeDetail = details.find((detail) => detail.pageNumber === page);

  const showView = (next: DrawingView, nextPage?: number) => {
    setView(next);
    const pages =
      next === "floor"
        ? floorPages.length > 0
          ? floorPages
          : Array.from({ length: buildingPageCount }, (_, index) => index + 1)
        : detailPages.length > 0
          ? detailPages
          : Array.from({ length: specsPageCount }, (_, index) => index + 1);
    setPage(nextPage ?? pages[0] ?? 1);
    setPlacingId(null);
  };

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
    `${openingMarkLabel(o.opening_code)}${o.window_types ? ` ${o.window_types.type_code}` : ""}${
      o.assignee ? ` — ${o.assignee.display_name}` : ""
    }`;

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
              Plansets
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

      {(buildingPdf || specsPdf) && (
        <>
          <nav className="drawing-view-tabs" aria-label="PDF drawing view">
            {buildingPdf && (
              <button
                type="button"
                className={view === "floor" ? "chip active" : "chip"}
                onClick={() => showView("floor")}
              >
                2D floor plan
              </button>
            )}
            {specsPdf && (
              <button
                type="button"
                className={view === "details" ? "chip active" : "chip"}
                onClick={() => showView("details")}
              >
                Window &amp; door details
              </button>
            )}
          </nav>
          <p className="pdf-source-line">
            <strong>PDF source:</strong>{" "}
            {activePlanset?.storage_path.split("/").pop() ?? "loading…"}
            {view === "floor" && floorPages.length > 0
              ? ` · ${floorPages.length} floor drawing${floorPages.length === 1 ? "" : "s"} found`
              : ""}
          </p>
        </>
      )}

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
            Plansets
          </Link>
          <Link to={`/projects/${projectId}/review`} className="button-like">
            Openings
          </Link>
        </div>
      )}

      {mapError && <p className="error">{mapError}</p>}

      {!buildingPdf && !specsPdf && (
        <p className="muted">
          No project PDFs yet.{" "}
          <Link to={`/projects/${projectId}/upload`}>Upload building plan</Link>{" "}
          and window/door details to build the 2D drawing.
        </p>
      )}

      {placingId && view === "floor" && (
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
            className={`plan-map plan-map--pdf-sketch${placingId && view === "floor" ? " placing" : ""}`}
            onClick={handleMapClick}
          >
            <img
              src={image.dataUrl}
              alt={`${view === "floor" ? "Floor plan" : "Window and door detail"} PDF page ${page}`}
            />
            {view === "floor" && onThisPage.map((o) => {
              const kind = unitKind(o);
              const isVoided = isLead && o.status !== "installed" && voidedIds.has(o.id);
              return (
              <button
                key={o.id}
                className={`map-pin map-pin--${kind}${isVoided ? " map-pin--voided" : ""}`}
                style={{
                  left: `${(o.pin_x ?? 0) * 100}%`,
                  top: `${(o.pin_y ?? 0) * 100}%`,
                  background: OPENING_KIND_COLORS[kind],
                  boxShadow: isVoided
                    ? `0 0 0 3px ${VOIDED_RING_COLOR}`
                    : `0 0 0 2px ${OPENING_STATUS_COLORS[o.status]}`,
                }}
                title={
                  isVoided ? `${pinTitle(o)} — install undone, needs re-do` : pinTitle(o)
                }
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
                {isVoided ? "! " : ""}
                {openingMarkLabel(o.opening_code)}
              </button>
              );
            })}
          </div>
          {view === "details" && activeDetail && (
            <div className="cad-detail-caption">
              <strong>
                {activeDetail.marks.length > 0
                  ? activeDetail.marks.map((mark) => `#${mark}`).join(" · ")
                  : `Detail sheet ${page}`}
              </strong>
              {activeDetail.productCodes.length > 0 && (
                <span>{activeDetail.productCodes.join(" · ")}</span>
              )}
              {activeDetail.notes.length > 0 && (
                <span>{activeDetail.notes.join(" · ")}</span>
              )}
            </div>
          )}
        </div>
      )}

      {visiblePages.length > 1 && (
        <nav className="hub-tabs page-switch" aria-label="Plan pages">
          <button
            type="button"
            className="hub-tab"
            disabled={pageIndex <= 0}
            onClick={() => setPage(visiblePages[pageIndex - 1])}
          >
            ◀
          </button>
          <span className="hub-tab active" style={{ pointerEvents: "none" }}>
            PDF page {page} · {pageIndex + 1} / {visiblePages.length}
          </span>
          <button
            type="button"
            className="hub-tab"
            disabled={pageIndex >= visiblePages.length - 1}
            onClick={() => setPage(visiblePages[pageIndex + 1])}
          >
            ▶
          </button>
        </nav>
      )}

      {details.length > 0 && (
        <section className="cad-detail-index">
          <div className="row-between">
            <h2>PDF window &amp; door details</h2>
            {view !== "details" && (
              <button type="button" className="link" onClick={() => showView("details")}>
                Open detail sheets
              </button>
            )}
          </div>
          <p className="muted">
            Marks, product codes, glazing, and hardware below are read from the
            uploaded manufacturer PDF. No Smith demo types are mixed in.
          </p>
          <div className="cad-detail-grid">
            {details.map((detail) => (
              <button
                key={detail.pageNumber}
                type="button"
                className={view === "details" && page === detail.pageNumber ? "cad-detail-card active" : "cad-detail-card"}
                onClick={() => showView("details", detail.pageNumber)}
              >
                <span className="field-label">PDF page {detail.pageNumber}</span>
                <strong>
                  {detail.marks.length > 0
                    ? detail.marks.map((mark) => `#${mark}`).join(" · ")
                    : "Manufacturer detail"}
                </strong>
                {detail.productCodes.length > 0 && (
                  <span>{detail.productCodes.join(" · ")}</span>
                )}
                {detail.notes.length > 0 && (
                  <small>{detail.notes.join(" · ")}</small>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="map-legend muted">
        <span>
          <i style={{ background: OPENING_KIND_COLORS.window }} /> window (#)
        </span>
        <span>
          <i style={{ background: OPENING_KIND_COLORS.door }} /> door (#)
        </span>
        <span>
          <i style={{ background: OPENING_STATUS_COLORS.planned }} /> planned
        </span>
        <span>
          <i style={{ background: OPENING_STATUS_COLORS.assigned }} /> assigned
        </span>
        <span>
          <i style={{ background: OPENING_STATUS_COLORS.installed }} /> installed
        </span>
        {isLead && (
          <span>
            <i style={{ background: VOIDED_RING_COLOR }} /> install undone
          </span>
        )}
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
                {image && view === "floor" && (
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
        {filtered.map((o) => {
          const isVoided = isLead && o.status !== "installed" && voidedIds.has(o.id);
          return (
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
              style={{ color: isVoided ? VOIDED_RING_COLOR : OPENING_STATUS_COLORS[o.status] }}
            >
              {isVoided ? "redo needed" : o.status}
            </span>
            {o.status === "installed" ? (
              isLead && (
                <button
                  className="link"
                  style={{ marginLeft: 8 }}
                  disabled={undo.isPending}
                  onClick={() => handleUndo(o)}
                >
                  Undo install
                </button>
              )
            ) : (
              <Link
                to={`/projects/${projectId}/opening/${o.id}`}
                className="link"
                style={{ marginLeft: 8 }}
              >
                {o.status === "planned" ? "Claim" : "Open"}
              </Link>
            )}
          </li>
          );
        })}
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
