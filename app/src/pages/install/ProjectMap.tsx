import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listProjects } from "../../lib/api";
import {
  downloadPlanset,
  getMyProfile,
  listOpenings,
  listPlansets,
  listVoidedInstallOpeningIds,
  undoInstall,
  updateOpening,
} from "../../lib/install/api";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import {
  isForemanPlus,
  OPENING_KIND_COLORS,
  OPENING_STATUS_COLORS,
  openingMarkCode,
  openingMarkLabel,
  type ProjectOpening,
} from "../../lib/install/types";
import {
  extractCadDetailPages,
  findFloorPlanPages,
  type CadDetailPage,
} from "../../lib/install/planDetails";
import {
  extractBuildingOutline,
  perimeterPositions,
  type BuildingOutline,
} from "../../lib/install/outline";

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

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
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
  const [filter, setFilter] = useState<PlanFilter>("all");
  const buildingDocRef = useRef<PDFDocumentProxy | null>(null);
  const specsDocRef = useRef<PDFDocumentProxy | null>(null);
  const [docsReady, setDocsReady] = useState(0);

  // Cartoon plan state: per-page traced outlines, selection, drag.
  const [outlines, setOutlines] = useState<Record<number, BuildingOutline | null>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{
    id: string;
    startClientX: number;
    startClientY: number;
    moved: boolean;
    x: number;
    y: number;
  } | null>(null);
  const [pending, setPending] = useState<Record<string, { x: number; y: number }>>({});
  const sheetRef = useRef<HTMLDivElement | null>(null);

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
  const voided = useQuery({
    queryKey: ["voidedOpenings", projectId],
    queryFn: () => listVoidedInstallOpeningIds(projectId),
  });
  const myProfile = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const isLead = isForemanPlus(myProfile.data?.role);
  const voidedIds = voided.data ?? new Set<string>();

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
        setOutlines({});
        setDocsReady((ready) => ready + 1);
      } catch (e) {
        if (!cancelled) setMapError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildingPdf?.id, specsPdf?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trace the building outline for the active floor page (cached per page).
  useEffect(() => {
    if (view !== "floor") return;
    const doc = buildingDocRef.current;
    if (!doc || page < 1 || page > doc.numPages) return;
    if (outlines[page] !== undefined) return;
    let cancelled = false;
    extractBuildingOutline(doc, page)
      .then((result) => {
        if (!cancelled) setOutlines((prev) => ({ ...prev, [page]: result }));
      })
      .catch(() => {
        if (!cancelled) setOutlines((prev) => ({ ...prev, [page]: null }));
      });
    return () => {
      cancelled = true;
    };
  }, [view, page, docsReady, outlines]);

  // Detail sheets still show the manufacturer PDF pages as-is.
  useEffect(() => {
    if (view !== "details") return;
    const doc = specsDocRef.current;
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
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    },
    onError: (e) => setMapError(String(e)),
  });

  // Drop optimistic positions once fresh data arrives.
  useEffect(() => {
    setPending({});
  }, [openings.dataUpdatedAt]);

  const all = openings.data ?? [];
  const filtered = all.filter(matchesFilter);
  const placed = filtered.filter(
    (o) => o.pin_x !== null && o.pin_y !== null && o.page_number === page,
  );
  const autos = filtered
    .filter((o) => o.pin_x === null || o.pin_y === null)
    .sort((a, b) =>
      openingMarkCode(a.opening_code).localeCompare(
        openingMarkCode(b.opening_code),
        undefined,
        { numeric: true },
      ),
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

  const outline = outlines[page] ?? null;
  const outlineLoading = view === "floor" && outlines[page] === undefined;
  const aspect = outline?.pageAspect ?? 0.7;

  const autoIds = autos.map((o) => o.id).join(",");
  const autoPositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    const positions = perimeterPositions(outline, autos.length);
    autos.forEach((o, i) => map.set(o.id, positions[i]));
    return map;
  }, [outline, autoIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const dotPos = (o: ProjectOpening): { x: number; y: number; auto: boolean } => {
    if (drag?.id === o.id) return { x: drag.x, y: drag.y, auto: false };
    const p = pending[o.id];
    if (p) return { x: p.x, y: p.y, auto: false };
    if (o.pin_x !== null && o.pin_y !== null)
      return { x: o.pin_x, y: o.pin_y, auto: false };
    const a = autoPositions.get(o.id);
    return { x: a?.x ?? 0.5, y: a?.y ?? 0.5, auto: true };
  };

  const beginDrag =
    (o: ProjectOpening) => (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = dotPos(o);
      const session = {
        id: o.id,
        startClientX: e.clientX,
        startClientY: e.clientY,
        moved: false,
        x: cur.x,
        y: cur.y,
      };
      dragRef.current = session;
      setDrag({ id: o.id, x: cur.x, y: cur.y });

      // Document-level listeners so drag keeps working even if the pointer
      // leaves the button (and so synthetic events from tests land correctly).
      const onMove = (ev: PointerEvent) => {
        const d = dragRef.current;
        const sheet = sheetRef.current;
        if (!d || !sheet) return;
        if (
          !d.moved &&
          Math.hypot(ev.clientX - d.startClientX, ev.clientY - d.startClientY) > 5
        ) {
          d.moved = true;
        }
        if (!d.moved) return;
        const rect = sheet.getBoundingClientRect();
        const next = {
          id: d.id,
          x: clamp((ev.clientX - rect.left) / rect.width, 0.015, 0.985),
          y: clamp((ev.clientY - rect.top) / rect.height, 0.02, 0.98),
        };
        d.x = next.x;
        d.y = next.y;
        setDrag(next);
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        const d = dragRef.current;
        dragRef.current = null;
        if (!d) return;
        if (d.moved) {
          setPending((prev) => ({ ...prev, [d.id]: { x: d.x, y: d.y } }));
          placePin.mutate({ id: d.id, x: d.x, y: d.y });
        } else {
          setSelectedId((prev) => (prev === d.id ? null : d.id));
        }
        setDrag(null);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    };

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
  };

  const pinTitle = (o: ProjectOpening) =>
    `${openingMarkLabel(o.opening_code)}${o.window_types ? ` ${o.window_types.type_code}` : ""}${
      o.assignee ? ` — ${o.assignee.display_name}` : ""
    }`;

  const openOpening = (openingId: string) =>
    navigate(`/projects/${projectId}/opening/${openingId}`);

  const selectedOpening = all.find((o) => o.id === selectedId) ?? null;
  const selectedDetail = selectedOpening
    ? details.find((d) =>
        d.marks.includes(openingMarkCode(selectedOpening.opening_code)),
      )
    : null;

  const outlinePath = useMemo(() => {
    if (!outline || outline.points.length < 3) return null;
    const h = 1000 * aspect;
    return (
      outline.points
        .map(
          (p, i) =>
            `${i === 0 ? "M" : "L"}${(p.x * 1000).toFixed(1)} ${(p.y * h).toFixed(1)}`,
        )
        .join(" ") + " Z"
    );
  }, [outline, aspect]);

  const renderDetailCard = (o: ProjectOpening) => {
    const kind = unitKind(o);
    const wt = o.window_types;
    const isVoided = o.status !== "installed" && voidedIds.has(o.id);
    return (
      <div className="map-detail-card">
        <div className="map-detail-card__head">
          <span
            className="map-detail-card__dot"
            style={{ background: OPENING_KIND_COLORS[kind] }}
            aria-hidden
          />
          <strong>
            #{openingMarkCode(o.opening_code)}
            {wt ? ` · ${wt.name || wt.type_code}` : ""}
          </strong>
          <span className="map-detail-card__cat">{wt?.category ?? kind}</span>
          <button
            type="button"
            className="map-detail-card__close"
            aria-label="Close details"
            onClick={() => setSelectedId(null)}
          >
            ✕
          </button>
        </div>
        <dl className="map-detail-card__rows">
          {wt?.width_in != null && wt?.height_in != null && (
            <div>
              <dt>Size</dt>
              <dd>
                {wt.width_in}″ × {wt.height_in}″
              </dd>
            </div>
          )}
          <div>
            <dt>Status</dt>
            <dd
              style={{
                color: isVoided ? VOIDED_RING_COLOR : OPENING_STATUS_COLORS[o.status],
              }}
            >
              {isVoided ? "install undone — redo needed" : o.status}
            </dd>
          </div>
          {o.label && (
            <div>
              <dt>Location</dt>
              <dd>{o.label}</dd>
            </div>
          )}
          {o.assignee && (
            <div>
              <dt>Assigned</dt>
              <dd>{o.assignee.display_name}</dd>
            </div>
          )}
          {o.ro_width_in != null && o.ro_height_in != null && (
            <div>
              <dt>Rough opening</dt>
              <dd>
                {o.ro_width_in}″ × {o.ro_height_in}″
              </dd>
            </div>
          )}
          {selectedDetail && selectedDetail.productCodes.length > 0 && (
            <div>
              <dt>Product</dt>
              <dd>{selectedDetail.productCodes.join(" · ")}</dd>
            </div>
          )}
        </dl>
        {wt?.notes && <p className="map-detail-card__notes">{wt.notes}</p>}
        {selectedDetail && selectedDetail.notes.length > 0 && (
          <p className="map-detail-card__notes">
            {selectedDetail.notes.join(" · ")}
          </p>
        )}
        <div className="map-detail-card__actions">
          <button
            type="button"
            className="button-like"
            onClick={() => openOpening(o.id)}
          >
            Open full sheet
          </button>
          {selectedDetail && (
            <button
              type="button"
              className="link"
              onClick={() => showView("details", selectedDetail.pageNumber)}
            >
              Detail sheet — PDF page {selectedDetail.pageNumber}
            </button>
          )}
        </div>
      </div>
    );
  };

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
        {unplaced.length > 0 &&
          ` — ${unplaced.length} auto-placed (dashed) · drag dots to set them`}
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
                Building plan
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

      {view === "floor" && buildingPdf && (
        <div className="plan-sheet plan-sheet--cad">
          <div className="cartoon-sheet__head">
            <span className="cartoon-sheet__title">
              {project?.job_code ?? "PLAN"} · BUILDING OUTLINE
            </span>
            <span className="cartoon-sheet__status">
              {outlineLoading
                ? "tracing plan…"
                : outlinePath
                  ? "outline from CAD"
                  : "outline unavailable — schematic"}
            </span>
          </div>
          <div
            ref={sheetRef}
            className="cartoon-sheet"
            style={{ aspectRatio: `1 / ${aspect}` }}
          >
            <svg
              viewBox={`0 0 1000 ${Math.round(1000 * aspect)}`}
              preserveAspectRatio="none"
              aria-hidden
            >
              {outlinePath ? (
                <path
                  d={outlinePath}
                  fill="rgba(163, 156, 146, 0.06)"
                  stroke="rgba(163, 156, 146, 0.6)"
                  strokeWidth={3}
                  strokeLinejoin="round"
                />
              ) : (
                !outlineLoading && (
                  <rect
                    x={120}
                    y={0.15 * 1000 * aspect}
                    width={760}
                    height={0.7 * 1000 * aspect}
                    rx={10}
                    fill="rgba(163, 156, 146, 0.06)"
                    stroke="rgba(163, 156, 146, 0.6)"
                    strokeWidth={3}
                  />
                )
              )}
            </svg>
            {[...placed, ...autos].map((o) => {
              const kind = unitKind(o);
              const isVoided = o.status !== "installed" && voidedIds.has(o.id);
              const pos = dotPos(o);
              return (
                <button
                  key={o.id}
                  type="button"
                  className={`plan-dot${pos.auto ? " plan-dot--auto" : ""}${
                    selectedId === o.id ? " plan-dot--selected" : ""
                  }${drag?.id === o.id ? " plan-dot--dragging" : ""}`}
                  style={{
                    left: `${pos.x * 100}%`,
                    top: `${pos.y * 100}%`,
                    background: OPENING_KIND_COLORS[kind],
                    borderColor: isVoided
                      ? VOIDED_RING_COLOR
                      : OPENING_STATUS_COLORS[o.status],
                  }}
                  title={
                    isVoided
                      ? `${pinTitle(o)} — install undone, needs re-do`
                      : pinTitle(o)
                  }
                  onPointerDown={beginDrag(o)}
                >
                  {openingMarkCode(o.opening_code)}
                </button>
              );
            })}
            <div className="cartoon-sheet__source">
              FROM CAD · {buildingPdf.storage_path.split("/").pop()}
            </div>
          </div>
          {selectedOpening && renderDetailCard(selectedOpening)}
        </div>
      )}

      {view === "details" && image && (
        <div className="plan-sheet">
          <div className="plan-map plan-map--pdf-sketch">
            <img
              src={image.dataUrl}
              alt={`Window and door detail PDF page ${page}`}
            />
          </div>
          {activeDetail && (
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
            {view === "floor" ? "Floor" : "PDF page"} {page} · {pageIndex + 1} /{" "}
            {visiblePages.length}
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
        <span>
          <i style={{ background: VOIDED_RING_COLOR }} /> install undone
        </span>
      </div>

      <h2>
        {filter === "all" ? "All openings" : FILTERS.find((f) => f.id === filter)?.label}{" "}
        ({filtered.length})
      </h2>
      <ul className="unit-list work-list">
        {filtered.map((o) => {
          const isVoided = o.status !== "installed" && voidedIds.has(o.id);
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
