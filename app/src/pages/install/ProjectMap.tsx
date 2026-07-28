import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listProjects, listWindowTypes } from "../../lib/api";
import {
  aiExtractSchedule,
  assignOpeningToInstaller,
  downloadPlanset,
  ensureTypesFromSpecs,
  linkSpecsToOpenings,
  listOpenings,
  listPlanOutlines,
  listPlansets,
  listProfiles,
  listVoidedInstallOpeningIds,
  saveDraftOpenings,
  setOpeningsSequence,
  unassignOpening,
  undoInstall,
  updateOpening,
} from "../../lib/install/api";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import {
  isForemanPlus,
  OPENING_KIND_COLORS,
  OPENING_STATUS_COLORS,
  openingMarkCode,
  openingMarkLabel,
  type Planset,
  type ProjectOpening,
} from "../../lib/install/types";
import {
  buildInstallerWorklist,
  buildSequenceAssignments,
  installerColorMap,
  installerInitials,
  maxExistingSequence,
  reorderById,
  sortedAssignedIds,
  toggleSelection,
} from "../../lib/install/mapDispatch";
import {
  extractCadDetailPages,
  findFloorPlanPages,
  type CadDetailPage,
} from "../../lib/install/planDetails";
import {
  extractScheduleRows,
  rowsToDraftOpenings,
  calloutsToDraftOpenings,
  summarizeDraftMarks,
} from "../../lib/install/extract";
import {
  outlinePathWithOpenings,
  parseOutlineFeatures,
} from "../../lib/install/cad";
import { formatApiError } from "../../lib/install/errors";
import { openingMarkerStyle } from "../../lib/install/openingMarkerScale";
import {
  extractBuildingOutline,
  outlinePathD,
  perimeterPositions,
  preferOutline,
  type BuildingOutline,
} from "../../lib/install/outline";
import { OutlineFeatureLayer } from "./OutlineFeatureLayer";
import { PlanModelEditor } from "./PlanModelEditor";

function plansetLabel(ps: Planset): string {
  return ps.storage_path.split("/").pop() ?? ps.storage_path;
}

function isUsablePdf(ps: Planset): boolean {
  return ps.source_format === "pdf" || !!ps.converted_pdf_path;
}

/** Distinct ring for an opening whose install was undone (history preserved). */
const VOIDED_RING_COLOR = "#ef4444";

interface PageImage {
  dataUrl: string;
  width: number;
  height: number;
}

type PlanFilter = "all" | "open" | "windows" | "doors" | "done";
/** Outline = cartoon extract; building = original floor PDF; details = specs PDF. */
type DrawingView = "outline" | "building" | "details";

const FILTERS: { id: PlanFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "windows", label: "Windows" },
  { id: "doors", label: "Doors" },
  { id: "done", label: "Done" },
];

function unitKind(o: ProjectOpening): "door" | "window" {
  const category = (o.window_types?.category ?? "").toLowerCase();
  if (category.includes("door")) return "door";
  if (category.includes("window")) return "window";
  const code = `${o.window_types?.type_code ?? ""} ${o.window_types?.name ?? ""}`.toUpperCase();
  if (/\b\d{2}(70|80)\b/.test(code) && /\b(XO|OX|SC)\b/.test(code)) return "door";
  if (/\bDOOR\b/.test(code)) return "door";
  return "window";
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function ProjectMap({ embedded = false }: { embedded?: boolean }) {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [view, setView] = useState<DrawingView>("outline");
  const [floorPages, setFloorPages] = useState<number[]>([]);
  const [buildingPageCount, setBuildingPageCount] = useState(0);
  const [specsPageCount, setSpecsPageCount] = useState(0);
  const [details, setDetails] = useState<CadDetailPage[]>([]);
  const [image, setImage] = useState<PageImage | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [filter, setFilter] = useState<PlanFilter>("all");
  const [fullScreen, setFullScreen] = useState(false);
  const [pdfZoom, setPdfZoom] = useState(1);
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
  const [buildingPlansetId, setBuildingPlansetId] = useState<string | null>(null);
  const [specsPlansetId, setSpecsPlansetId] = useState<string | null>(null);
  const [extractNote, setExtractNote] = useState<string | null>(null);
  const [editingModel, setEditingModel] = useState(false);

  // Map-based ordered dispatch (foreman+). Tapping pins builds an ordered
  // selection for the chosen installer; the tap order IS the completion order.
  const [dispatchMode, setDispatchMode] = useState(false);
  const [dispatchInstaller, setDispatchInstaller] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);

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
  const types = useQuery({ queryKey: ["windowTypes"], queryFn: listWindowTypes });
  const planOutlines = useQuery({
    queryKey: ["planOutlines", projectId, buildingPlansetId],
    queryFn: () =>
      buildingPlansetId
        ? listPlanOutlines(projectId, buildingPlansetId)
        : Promise.resolve([]),
    enabled: !!buildingPlansetId,
  });
  const { effectiveRole } = useEffectiveRole();
  // Failed/undone-install markers are foreman+ only. Installers never see the
  // voided ring, legend, or "redo needed" state; the query is also gated so the
  // data is never fetched for a non-foreman (faithful under view-as preview too).
  const isLead = isForemanPlus(effectiveRole);
  // Crew list drives the dispatch installer picker + at-a-glance pin coloring.
  // The color layer is visible to everyone, so this query is not lead-gated.
  const crew = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const activeCrew = useMemo(
    () => (crew.data ?? []).filter((c) => c.active),
    [crew.data],
  );
  // Stable installer → color map keyed on active-crew order (see mapDispatch).
  const crewColors = useMemo(
    () => installerColorMap(activeCrew.map((c) => c.id)),
    [activeCrew],
  );
  const crewNameById = useMemo(
    () => new Map((crew.data ?? []).map((c) => [c.id, c.display_name])),
    [crew.data],
  );
  const voided = useQuery({
    queryKey: ["voidedOpenings", projectId, isLead],
    queryFn: () => listVoidedInstallOpeningIds(projectId, isLead),
    enabled: isLead,
  });
  const voidedIds = isLead ? voided.data ?? new Set<string>() : new Set<string>();

  const buildingPdfs = useMemo(
    () =>
      (plansets.data ?? []).filter(
        (ps) => (ps.kind ?? "building") === "building" && isUsablePdf(ps),
      ),
    [plansets.data],
  );
  const specsPdfs = useMemo(
    () =>
      (plansets.data ?? []).filter(
        (ps) => ps.kind === "specs" && isUsablePdf(ps),
      ),
    [plansets.data],
  );

  // Keep selection valid when plansets load / change.
  useEffect(() => {
    if (buildingPdfs.length === 0) {
      setBuildingPlansetId(null);
      return;
    }
    setBuildingPlansetId((prev) =>
      prev && buildingPdfs.some((p) => p.id === prev) ? prev : buildingPdfs[0].id,
    );
  }, [buildingPdfs]);

  useEffect(() => {
    if (specsPdfs.length === 0) {
      setSpecsPlansetId(null);
      return;
    }
    setSpecsPlansetId((prev) =>
      prev && specsPdfs.some((p) => p.id === prev) ? prev : specsPdfs[0].id,
    );
  }, [specsPdfs]);

  const buildingPdf =
    buildingPdfs.find((ps) => ps.id === buildingPlansetId) ?? buildingPdfs[0] ?? null;
  const specsPdf =
    specsPdfs.find((ps) => ps.id === specsPlansetId) ?? specsPdfs[0] ?? null;

  const undo = useMutation({
    mutationFn: (args: { openingId: string; reason: string | null }) =>
      undoInstall(args.openingId, args.reason ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
      queryClient.invalidateQueries({ queryKey: ["voidedOpenings", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projectUnits", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projectExceptions", projectId] });
    },
    onError: (e) => setMapError(formatApiError(e)),
  });

  const handleUndo = (o: ProjectOpening) => {
    const reason = window.prompt(
      `Undo the install on ${o.opening_code}? The install record is kept for review.\n\nReason (optional):`,
    );
    if (reason === null) return; // cancelled
    undo.mutate({ openingId: o.id, reason: reason.trim() || null });
  };

  const reextractSpecs = useMutation({
    mutationFn: async () => {
      if (!specsPdf && !buildingPdf) {
        throw new Error("No building or specs PDF selected.");
      }
      setExtractNote("Reading planset PDFs…");
      const { extractAllText, extractPlanMarkCallouts, loadPdf } = await import(
        "../../lib/install/pdf"
      );

      let rows: Awaited<ReturnType<typeof extractScheduleRows>>["rows"] = [];
      let source: Awaited<ReturnType<typeof extractScheduleRows>>["source"] =
        "none";
      let pages: { pageNumber: number; text: string }[] = [];

      if (specsPdf) {
        setExtractNote("Reading specs PDF…");
        const doc = await loadPdf(await downloadPlanset(specsPdf));
        pages = await extractAllText(doc);
        const catalog = (types.data ?? []).map((t) => ({
          type_code: t.type_code,
          name: t.name,
        }));
        setExtractNote("Extracting window/door marks…");
        const extracted = await extractScheduleRows(pages, async (pgs) => {
          try {
            const aiRows = await aiExtractSchedule(pgs, catalog);
            return aiRows.map((r) => ({
              openingCode: r.openingCode,
              typeText: r.typeText,
              qty: r.qty,
              label: r.label,
              pageNumber: r.pageNumber,
              widthIn: r.widthIn ?? null,
              heightIn: r.heightIn ?? null,
              color: r.color ?? null,
              kind: r.kind ?? "window",
            }));
          } catch {
            return [];
          }
        });
        rows = extracted.rows;
        source = extracted.source;
        setDetails(extractCadDetailPages(pages));
        specsDocRef.current = doc;
        setSpecsPageCount(doc.numPages);
      }

      let drafts;
      if (buildingPdf) {
        setExtractNote("Reading mark callouts on the building plan…");
        const buildingDoc = await loadPdf(await downloadPlanset(buildingPdf));
        const callouts = await extractPlanMarkCallouts(buildingDoc);
        if (callouts.length > 0) {
          drafts = calloutsToDraftOpenings(callouts, rows, types.data ?? []);
          source = rows.length > 0 ? "merged" : "details";
        }
      }
      if (!drafts) {
        drafts = rowsToDraftOpenings(rows, types.data ?? []);
      }

      drafts = await ensureTypesFromSpecs(drafts);
      await linkSpecsToOpenings(projectId, drafts);
      const plansetId = specsPdf?.id ?? buildingPdf!.id;
      const result = await saveDraftOpenings(projectId, plansetId, drafts);
      return { result, source, marks: summarizeDraftMarks(drafts) };
    },
    onSuccess: ({ result, source, marks }) => {
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
      queryClient.invalidateQueries({ queryKey: ["windowTypes"] });
      const markLine = marks
        .map(
          (m) =>
            `${m.count}× #${m.mark} ${m.kind === "door" ? "doors" : "windows"}`,
        )
        .join(", ");
      setExtractNote(
        [
          markLine ? `Loaded ${markLine}.` : "No marks found.",
          result.inserted > 0 ? `${result.inserted} new drafts.` : null,
          result.skipped > 0
            ? `${result.skipped} already confirmed — left alone.`
            : null,
          source === "details"
            ? "Source: manufacturer detail sheets / plan callouts."
            : source === "merged"
              ? "Source: plan callouts + detail sheets."
              : null,
        ]
          .filter(Boolean)
          .join(" "),
      );
    },
    onError: (e) => {
      setExtractNote(null);
      setMapError(formatApiError(e));
    },
  });

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
        setFullScreen(false);
        setDocsReady((ready) => ready + 1);
      } catch (e) {
        if (!cancelled) setMapError(formatApiError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildingPdf?.id, specsPdf?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trace the building outline for the active floor page (cached per page).
  useEffect(() => {
    if (view !== "outline") return;
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

  // Original building PDF + specs detail sheets render as page images.
  useEffect(() => {
    if (view === "outline") return;
    const doc = view === "building" ? buildingDocRef.current : specsDocRef.current;
    if (!doc || page < 1 || page > doc.numPages) return;
    let cancelled = false;
    setImage(null);
    import("../../lib/install/pdf")
      .then(({ renderPageImage }) => renderPageImage(doc, page))
      .then((img) => !cancelled && setImage(img))
      .catch((e) => !cancelled && setMapError(formatApiError(e)));
    return () => {
      cancelled = true;
    };
  }, [page, view, docsReady]);

  // Escape exits fullscreen; lock body scroll while open.
  useEffect(() => {
    if (!fullScreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullScreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [fullScreen]);

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
    onError: (e) => setMapError(formatApiError(e)),
  });

  // Commit the ordered selection: assign each opening to the installer in tap
  // order. We pass the sequence per call so the new work APPENDS after the
  // installer's existing list (continuing past their current max) rather than
  // clobbering it.
  const assignSelection = useMutation({
    mutationFn: async (args: { installerId: string; orderedIds: string[] }) => {
      const startAfter = maxExistingSequence(
        openings.data ?? [],
        args.installerId,
        args.orderedIds,
      );
      const plan = buildSequenceAssignments(args.orderedIds, startAfter);
      for (const step of plan) {
        await assignOpeningToInstaller(
          step.openingId,
          args.installerId,
          step.sequence,
        );
      }
      return plan.length;
    },
    onSuccess: (count, args) => {
      const name = crewNameById.get(args.installerId) ?? "installer";
      setDispatchNote(
        `Added ${count} opening${count === 1 ? "" : "s"} to ${name}'s list.`,
      );
      setSelection([]);
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    },
    onError: (e) => setMapError(formatApiError(e)),
  });

  // Drop an EXISTING assignment off the installer's route, then renumber the
  // openings they keep so the saved sequence stays a clean 1..M with no gaps.
  const removeExisting = useMutation({
    mutationFn: async (args: { installerId: string; openingId: string }) => {
      const remaining = sortedAssignedIds(
        openings.data ?? [],
        args.installerId,
      ).filter((id) => id !== args.openingId);
      await unassignOpening(args.openingId);
      if (remaining.length > 0) await setOpeningsSequence(remaining);
    },
    onSuccess: () => {
      setDispatchNote("Removed from the list — the rest were renumbered.");
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    },
    onError: (e) => setMapError(formatApiError(e)),
  });

  // Persist a reordered existing route (up/down within the saved list).
  const reorderExisting = useMutation({
    mutationFn: (orderedIds: string[]) => setOpeningsSequence(orderedIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    },
    onError: (e) => setMapError(formatApiError(e)),
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
  const pinnedPlanPages = [
    ...new Set(
      all
        .filter((o) => o.pin_x !== null && o.pin_y !== null && o.page_number != null)
        .map((o) => o.page_number as number),
    ),
  ].sort((a, b) => a - b);
  const visiblePages =
    view === "details"
      ? detailPages.length > 0
        ? detailPages
        : Array.from({ length: specsPageCount }, (_, index) => index + 1)
      : view === "building"
        ? pinnedPlanPages.length > 0
          ? pinnedPlanPages
          : floorPages.length > 0
            ? floorPages
            : Array.from({ length: buildingPageCount }, (_, index) => index + 1)
        : floorPages.length > 0
          ? floorPages
          : Array.from({ length: buildingPageCount }, (_, index) => index + 1);
  const pageIndex = Math.max(0, visiblePages.indexOf(page));
  const activePlanset = view === "details" ? specsPdf : buildingPdf;
  const activeDetail = details.find((detail) => detail.pageNumber === page);

  const extractedOutline = outlines[page] ?? null;
  const manualOutlineRows = useMemo(
    () =>
      (planOutlines.data ?? []).filter(
        (outline) => outline.page_number === page,
      ),
    [planOutlines.data, page],
  );
  const manualOutlineRow = manualOutlineRows[0];
  const manualOutline: BuildingOutline | null = manualOutlineRow
    ? {
        points: manualOutlineRow.points,
        pageAspect: manualOutlineRow.page_aspect,
      }
    : null;
  const outline = preferOutline(manualOutline, extractedOutline);
  const outlineLoading =
    view === "outline" &&
    !manualOutline &&
    outlines[page] === undefined &&
    !planOutlines.isLoading;
  const aspect =
    outline?.pageAspect ??
    manualOutline?.pageAspect ??
    extractedOutline?.pageAspect ??
    0.7;

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
        } else if (dispatchMode) {
          // A no-move tap toggles the pin into/out of the ordered selection.
          setSelection((prev) => toggleSelection(prev, d.id));
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
    if (next !== "outline") setEditingModel(false);
    const pages =
      next === "details"
        ? detailPages.length > 0
          ? detailPages
          : Array.from({ length: specsPageCount }, (_, index) => index + 1)
        : next === "building" && pinnedPlanPages.length > 0
          ? pinnedPlanPages
          : floorPages.length > 0
            ? floorPages
            : Array.from({ length: buildingPageCount }, (_, index) => index + 1);
    setPage(nextPage ?? pages[0] ?? 1);
    setPdfZoom(1);
  };

  const bumpZoom = (dir: 1 | -1) => {
    setPdfZoom((z) =>
      Math.min(4, Math.max(0.5, Math.round((z + dir * 0.25) * 100) / 100)),
    );
  };

  const pinTitle = (o: ProjectOpening) =>
    `${openingMarkLabel(o.opening_code)}${o.window_types ? ` ${o.window_types.type_code}` : ""}${
      o.assignee
        ? ` — ${o.assignee.display_name}${o.sequence != null ? ` · #${o.sequence}` : ""}`
        : ""
    }`;

  const openOpening = (openingId: string) =>
    navigate(`/projects/${projectId}/opening/${openingId}`);

  const selectedOpening = all.find((o) => o.id === selectedId) ?? null;

  const installerExistingCount = dispatchInstaller
    ? all.filter(
        (o) => o.assigned_to === dispatchInstaller && !selection.includes(o.id),
      ).length
    : 0;
  // The chosen installer's FULL ordered worklist: already-assigned openings in
  // saved sequence order, then the pins tapped now appended after them. This is
  // what the foreman sees in the panel and the numbers stamped on the map.
  const worklist =
    dispatchMode && dispatchInstaller
      ? buildInstallerWorklist(all, dispatchInstaller, selection)
      : [];
  const worklistOpenings = worklist
    .map((item) => {
      const opening = all.find((o) => o.id === item.id);
      return opening ? { ...item, opening } : null;
    })
    .filter((row): row is typeof row & { opening: ProjectOpening } => !!row);
  // id → route order number and id → is-newly-tapped, for the map overlay.
  const routeOrder = new Map(worklist.map((w) => [w.id, w.order]));
  const routeNewIds = new Set(
    worklist.filter((w) => w.isNew).map((w) => w.id),
  );
  const hasRoute = dispatchMode && !!dispatchInstaller;
  const existingRouteIds = hasRoute
    ? sortedAssignedIds(all, dispatchInstaller, selection)
    : [];
  // Installers with assignments among the pins currently rendered → legend.
  const legendInstallers = (() => {
    const seen = new Set<string>();
    const rows: { id: string; name: string; color: string }[] = [];
    for (const o of [...placed, ...autos]) {
      if (!o.assigned_to || seen.has(o.assigned_to)) continue;
      seen.add(o.assigned_to);
      rows.push({
        id: o.assigned_to,
        name:
          o.assignee?.display_name ??
          crewNameById.get(o.assigned_to) ??
          "installer",
        color: crewColors.get(o.assigned_to) ?? "#a39c92",
      });
    }
    return rows;
  })();
  const selectedDetail = selectedOpening
    ? details.find((d) =>
        d.marks.includes(openingMarkCode(selectedOpening.opening_code)),
      )
    : null;

  const outlinePath = useMemo(
    () => (outline ? outlinePathD(outline.points, aspect) : null),
    [outline, aspect],
  );
  const manualOutlinePaths = useMemo(
    () =>
      manualOutlineRows
        .map((row) => {
          const features = parseOutlineFeatures(row.features);
          const fill = outlinePathD(row.points, aspect);
          const stroke =
            features.wallOpenings.length > 0
              ? outlinePathWithOpenings(row.points, aspect, features.wallOpenings)
              : fill;
          return { id: row.id, points: row.points, fill, stroke, features };
        })
        .filter(
          (path): path is typeof path & { fill: string } => !!path.fill,
        ),
    [manualOutlineRows, aspect],
  );

  const renderDetailCard = (o: ProjectOpening) => {
    const kind = unitKind(o);
    const wt = o.window_types;
    const isVoided = isLead && o.status !== "installed" && voidedIds.has(o.id);
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
              <dd>
                <span
                  className="map-detail-card__installer"
                  style={{
                    background: crewColors.get(o.assignee.id) ?? "#a39c92",
                  }}
                  aria-hidden
                >
                  {installerInitials(o.assignee.display_name)}
                </span>
                {o.assignee.display_name}
                {o.sequence != null && ` · #${o.sequence}`}
                {` · ${o.status}`}
              </dd>
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

  const renderOpeningDots = (mode: "all" | "pinned" = "all") =>
    (mode === "pinned" ? placed : [...placed, ...autos]).map((o) => {
      const kind = unitKind(o);
      const isVoided = isLead && o.status !== "installed" && voidedIds.has(o.id);
      const pos = dotPos(o);
      const selIndex = selection.indexOf(o.id);
      const installerColor = o.assigned_to
        ? crewColors.get(o.assigned_to)
        : undefined;
      // When an installer is chosen, number THEIR route (existing + pending)
      // and dim everything else so the foreman can read the route at a glance.
      const routeNum = hasRoute ? routeOrder.get(o.id) : undefined;
      const onRoute = routeNum != null;
      const isNewOnRoute = onRoute && routeNewIds.has(o.id);
      const dimmed = hasRoute && !onRoute;
      // Fall back to the plain tap-order number when no installer is chosen yet.
      const seqNum = onRoute ? routeNum : selIndex >= 0 ? selIndex + 1 : null;
      const showInstallerBadge =
        installerColor && seqNum == null && !dimmed;
      return (
        <button
          key={o.id}
          type="button"
          aria-pressed={dispatchMode ? selIndex >= 0 || isNewOnRoute : undefined}
          className={`plan-dot${pos.auto ? " plan-dot--auto" : ""}${
            selectedId === o.id ? " plan-dot--selected" : ""
          }${drag?.id === o.id ? " plan-dot--dragging" : ""}${
            selIndex >= 0 || isNewOnRoute ? " plan-dot--dispatch-selected" : ""
          }${onRoute && !isNewOnRoute ? " plan-dot--dispatch-route" : ""}${
            dimmed ? " plan-dot--dispatch-dim" : ""
          }`}
          style={{
            left: `${pos.x * 100}%`,
            top: `${pos.y * 100}%`,
            ...openingMarkerStyle(o.id),
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
          {showInstallerBadge && (
            <span
              className="plan-dot__installer"
              style={{ background: installerColor }}
              aria-hidden
            >
              {installerInitials(o.assignee?.display_name ?? "?")}
            </span>
          )}
          {seqNum != null && (
            <span className="plan-dot__seq" aria-hidden>
              {seqNum}
            </span>
          )}
        </button>
      );
    });

  // Reset zoom when flipping PDF pages.
  useEffect(() => {
    setPdfZoom(1);
  }, [page, view]);

  const zoomControls = (view === "building" || view === "details") && (
    <div className="plan-zoom-controls" role="group" aria-label="Zoom">
      <button
        type="button"
        className="plan-zoom-btn"
        aria-label="Zoom out"
        disabled={pdfZoom <= 0.5}
        onClick={() => bumpZoom(-1)}
      >
        −
      </button>
      <button
        type="button"
        className="plan-zoom-btn plan-zoom-btn--label"
        aria-label="Reset zoom"
        title="Reset zoom"
        onClick={() => setPdfZoom(1)}
      >
        {Math.round(pdfZoom * 100)}%
      </button>
      <button
        type="button"
        className="plan-zoom-btn"
        aria-label="Zoom in"
        disabled={pdfZoom >= 4}
        onClick={() => bumpZoom(1)}
      >
        +
      </button>
    </div>
  );

  const fullscreenBar = (
    <div className="plan-fullscreen-bar">
      <button
        type="button"
        className="button-like plan-fullscreen-close"
        onClick={() => setFullScreen(false)}
      >
        ✕ Close
      </button>
      {zoomControls}
      {visiblePages.length > 1 && (
        <>
          <button
            type="button"
            className="hub-tab"
            disabled={pageIndex <= 0}
            onClick={() => setPage(visiblePages[pageIndex - 1])}
          >
            ◀
          </button>
          <span className="hub-tab active" style={{ pointerEvents: "none" }}>
            {view === "details" ? "PDF" : "Floor"} {page} · {pageIndex + 1} /{" "}
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
        </>
      )}
    </div>
  );

  const assignLabel = (() => {
    const n = selection.length;
    if (!dispatchInstaller) return `Assign ${n}`;
    const name = crewNameById.get(dispatchInstaller) ?? "installer";
    return installerExistingCount > 0
      ? `Add ${n} to ${name}'s list`
      : `Assign ${n} to ${name}`;
  })();

  const dispatchControls = isLead && (
    <div className="dispatch-map-controls">
      <div className="row-gap dispatch-map-controls__top">
        <button
          type="button"
          className={dispatchMode ? "chip active" : "chip"}
          aria-pressed={dispatchMode}
          onClick={() => {
            setDispatchMode((on) => !on);
            setSelection([]);
            setDispatchNote(null);
            setSelectedId(null);
          }}
        >
          {dispatchMode ? "Dispatch: on" : "Dispatch"}
        </button>
        {dispatchMode && (
          <label className="dispatch-map-controls__picker">
            <span className="field-label">Installer</span>
            <select
              value={dispatchInstaller}
              onChange={(e) => setDispatchInstaller(e.target.value)}
            >
              <option value="">Choose an installer…</option>
              {activeCrew.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}
                  {c.role !== "installer" ? ` (${c.role})` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {dispatchMode && (
        <div className="dispatch-panel">
          <div className="dispatch-panel__head">
            <strong>
              {dispatchInstaller
                ? `${crewNameById.get(dispatchInstaller) ?? "Installer"}'s install order`
                : "Tap pins in the order they should be installed"}
            </strong>
            {selection.length > 0 && (
              <button
                type="button"
                className="link"
                onClick={() => setSelection([])}
              >
                Clear taps
              </button>
            )}
          </div>

          {!dispatchInstaller ? (
            <p className="muted">
              Choose an installer above to see their full order and add
              window/door pins to their list.
            </p>
          ) : worklistOpenings.length === 0 ? (
            <p className="muted">
              {crewNameById.get(dispatchInstaller) ?? "This installer"} has no
              openings yet — tap window/door pins on the map, in order, to build
              their list.
            </p>
          ) : (
            <ol className="dispatch-worklist">
              {worklistOpenings.map((row) => {
                const code = openingMarkCode(row.opening.opening_code);
                const isFirstExisting = !row.isNew && row.order === 1;
                const isLastExisting =
                  !row.isNew && row.order === existingRouteIds.length;
                const busy =
                  removeExisting.isPending || reorderExisting.isPending;
                return (
                  <li
                    key={row.id}
                    className={`dispatch-worklist__row${
                      row.isNew
                        ? " dispatch-worklist__row--new"
                        : " dispatch-worklist__row--existing"
                    }`}
                  >
                    <span className="dispatch-panel__seq">{row.order}</span>
                    <span className="dispatch-worklist__code">#{code}</span>
                    {row.isNew ? (
                      <span className="dispatch-worklist__tag dispatch-worklist__tag--new">
                        adding now
                      </span>
                    ) : (
                      <span className="dispatch-worklist__tag">on list</span>
                    )}
                    <span className="dispatch-worklist__controls">
                      {!row.isNew && existingRouteIds.length > 1 && (
                        <>
                          <button
                            type="button"
                            className="dispatch-worklist__move"
                            aria-label={`Move #${code} earlier`}
                            disabled={isFirstExisting || busy}
                            onClick={() =>
                              reorderExisting.mutate(
                                reorderById(existingRouteIds, row.id, -1),
                              )
                            }
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="dispatch-worklist__move"
                            aria-label={`Move #${code} later`}
                            disabled={isLastExisting || busy}
                            onClick={() =>
                              reorderExisting.mutate(
                                reorderById(existingRouteIds, row.id, 1),
                              )
                            }
                          >
                            ↓
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="dispatch-panel__remove"
                        aria-label={
                          row.isNew
                            ? `Remove #${code} from the new taps`
                            : `Remove #${code} from ${crewNameById.get(dispatchInstaller) ?? "installer"}'s list`
                        }
                        disabled={busy}
                        onClick={() =>
                          row.isNew
                            ? setSelection((prev) =>
                                toggleSelection(prev, row.id),
                              )
                            : removeExisting.mutate({
                                installerId: dispatchInstaller,
                                openingId: row.id,
                              })
                        }
                      >
                        ✕
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          <button
            type="button"
            className="button-like button-like--primary dispatch-panel__assign"
            disabled={
              !dispatchInstaller ||
              selection.length === 0 ||
              assignSelection.isPending
            }
            onClick={() =>
              assignSelection.mutate({
                installerId: dispatchInstaller,
                orderedIds: selection,
              })
            }
          >
            {assignSelection.isPending ? "Adding…" : assignLabel}
          </button>
          {dispatchNote && <p className="dispatch-panel__note">{dispatchNote}</p>}
        </div>
      )}
    </div>
  );

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
              <>
                <button
                  type="button"
                  className={view === "outline" ? "chip active" : "chip"}
                  onClick={() => showView("outline")}
                >
                  Building outline
                </button>
                <button
                  type="button"
                  className={view === "building" ? "chip active" : "chip"}
                  onClick={() => showView("building")}
                >
                  Original plan
                </button>
              </>
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

          <div className="planset-picker-row">
            {buildingPdfs.length > 0 && (
              <label className="planset-picker">
                <span>Building planset</span>
                <select
                  value={buildingPdf?.id ?? ""}
                  onChange={(e) => {
                    setBuildingPlansetId(e.target.value);
                    setView("outline");
                    setOutlines({});
                    setFullScreen(false);
                  }}
                >
                  {buildingPdfs.map((ps) => (
                    <option key={ps.id} value={ps.id}>
                      {plansetLabel(ps)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {specsPdfs.length > 0 && (
              <label className="planset-picker">
                <span>Specs planset</span>
                <select
                  value={specsPdf?.id ?? ""}
                  onChange={(e) => {
                    setSpecsPlansetId(e.target.value);
                    setView("details");
                    setFullScreen(false);
                  }}
                >
                  {specsPdfs.map((ps) => (
                    <option key={ps.id} value={ps.id}>
                      {plansetLabel(ps)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {specsPdf && (
              <button
                type="button"
                className="button-like"
                disabled={reextractSpecs.isPending}
                onClick={() => reextractSpecs.mutate()}
              >
                {reextractSpecs.isPending
                  ? "Loading marks…"
                  : "Load marks from plans"}
              </button>
            )}
          </div>

          <p className="pdf-source-line">
            <strong>Viewing:</strong>{" "}
            {activePlanset ? plansetLabel(activePlanset) : "loading…"}
            {(view === "outline" || view === "building") && floorPages.length > 0
              ? ` · ${floorPages.length} numbered floor drawing${floorPages.length === 1 ? "" : "s"}`
              : ""}
            {view === "details" && details.length > 0
              ? ` · ${details.length} detail sheet${details.length === 1 ? "" : "s"}`
              : ""}
          </p>
          {extractNote && <p className="muted">{extractNote}</p>}
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

      {dispatchControls}

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

      {view === "outline" && buildingPdf && (
        <div
          className={`plan-sheet plan-sheet--cad${fullScreen ? " plan-sheet--fullscreen" : ""}`}
        >
          {fullScreen && fullscreenBar}
          <div className="cartoon-sheet__head">
            <span className="cartoon-sheet__title">
              {project?.job_code ?? "PLAN"} · BUILDING OUTLINE
            </span>
            <div className="cartoon-sheet__head-actions">
              <span className="cartoon-sheet__status">
                {editingModel
                  ? "editing model"
                  : outlineLoading
                    ? "tracing plan…"
                    : manualOutline
                      ? "manual outline"
                      : outlinePath
                        ? "outline from CAD"
                        : "outline unavailable — schematic"}
              </span>
              {!editingModel && (
                <button
                  type="button"
                  className="button-like"
                  onClick={() => {
                    setEditingModel(true);
                    setFullScreen(false);
                  }}
                >
                  Edit model
                </button>
              )}
              <button
                type="button"
                className="plan-fullscreen-toggle"
                title={fullScreen ? "Exit full screen" : "Full screen"}
                aria-label={fullScreen ? "Exit full screen" : "Full screen"}
                onClick={() => setFullScreen((v) => !v)}
              >
                ⛶
              </button>
            </div>
          </div>
          {editingModel ? (
            <PlanModelEditor
              projectId={projectId}
              planset={buildingPdf}
              page={page}
              openings={all}
              manualOutlines={manualOutlineRows}
              extractedOutline={extractedOutline}
              pageAspect={aspect}
              onClose={() => {
                setEditingModel(false);
                void planOutlines.refetch();
              }}
            />
          ) : (
            <>
              <div
                ref={sheetRef}
                className="cartoon-sheet"
                style={fullScreen ? undefined : { aspectRatio: `1 / ${aspect}` }}
              >
                <svg
                  viewBox={`0 0 1000 ${Math.round(1000 * aspect)}`}
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  {manualOutlinePaths.length > 0 ? (
                    manualOutlinePaths.map((path) => (
                      <g key={path.id}>
                        <path
                          d={path.fill}
                          fill="rgba(163, 156, 146, 0.06)"
                          stroke="none"
                        />
                        {path.stroke && (
                          <path
                            d={path.stroke}
                            fill="none"
                            stroke="rgba(255, 106, 26, 0.85)"
                            strokeWidth={3}
                            strokeLinejoin="round"
                            strokeLinecap="round"
                          />
                        )}
                        <OutlineFeatureLayer
                          points={path.points}
                          aspect={aspect}
                          features={path.features}
                          color="rgba(255, 106, 26, 0.85)"
                        />
                      </g>
                    ))
                  ) : outlinePath ? (
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
                {renderOpeningDots()}
                <div className="cartoon-sheet__source">
                  {manualOutline ? "MANUAL MODEL" : "FROM CAD"} ·{" "}
                  {buildingPdf.storage_path.split("/").pop()}
                </div>
              </div>
              {selectedOpening && renderDetailCard(selectedOpening)}
            </>
          )}
        </div>
      )}

      {view === "building" && buildingPdf && (
        <div
          className={`plan-sheet${fullScreen ? " plan-sheet--fullscreen" : ""}`}
        >
          {fullScreen && fullscreenBar}
          <div className="cartoon-sheet__head">
            <span className="cartoon-sheet__title">
              {project?.job_code ?? "PLAN"} · ORIGINAL BUILDING PLAN
            </span>
            <div className="cartoon-sheet__head-actions">
              <span className="cartoon-sheet__status">source PDF</span>
              {!fullScreen && zoomControls}
              <button
                type="button"
                className="plan-fullscreen-toggle"
                title={fullScreen ? "Exit full screen" : "Full screen"}
                aria-label={fullScreen ? "Exit full screen" : "Full screen"}
                onClick={() => setFullScreen((v) => !v)}
              >
                ⛶
              </button>
            </div>
          </div>
          {image ? (
            <div
              className="plan-zoom-viewport"
              onWheel={(e) => {
                if (!e.ctrlKey && !e.metaKey) return;
                e.preventDefault();
                bumpZoom(e.deltaY < 0 ? 1 : -1);
              }}
            >
              <div
                ref={sheetRef}
                className="plan-map plan-map--pdf-sketch plan-map--with-dots"
                style={{ width: `${pdfZoom * 100}%` }}
              >
                <img
                  src={image.dataUrl}
                  alt={`Building plan PDF page ${page}`}
                  draggable={false}
                />
                {renderOpeningDots("pinned")}
              </div>
            </div>
          ) : (
            <p className="muted" style={{ padding: "12px 6px" }}>
              Loading original plan…
            </p>
          )}
          <p className="muted" style={{ marginTop: 8 }}>
            Movable marks sit on the plan callouts. Zoom keeps them locked to
            those numbers — drag one to nudge it.
          </p>
          {selectedOpening && renderDetailCard(selectedOpening)}
        </div>
      )}

      {view === "details" && (
        <div
          className={`plan-sheet${fullScreen ? " plan-sheet--fullscreen" : ""}`}
        >
          {fullScreen && fullscreenBar}
          <div className="cartoon-sheet__head">
            <span className="cartoon-sheet__title">
              {project?.job_code ?? "PLAN"} · WINDOW &amp; DOOR DETAILS
            </span>
            <div className="cartoon-sheet__head-actions">
              <span className="cartoon-sheet__status">
                {activeDetail?.marks.length
                  ? activeDetail.marks.map((m) => `#${m}`).join(" · ")
                  : "specs PDF"}
              </span>
              {!fullScreen && zoomControls}
              <button
                type="button"
                className="plan-fullscreen-toggle"
                title={fullScreen ? "Exit full screen" : "Full screen"}
                aria-label={fullScreen ? "Exit full screen" : "Full screen"}
                onClick={() => setFullScreen((v) => !v)}
              >
                ⛶
              </button>
            </div>
          </div>
          {image ? (
            <div
              className="plan-zoom-viewport"
              onWheel={(e) => {
                if (!e.ctrlKey && !e.metaKey) return;
                e.preventDefault();
                bumpZoom(e.deltaY < 0 ? 1 : -1);
              }}
            >
              <div
                className="plan-map plan-map--pdf-sketch"
                style={{ width: `${pdfZoom * 100}%` }}
              >
                <img
                  src={image.dataUrl}
                  alt={`Window and door detail PDF page ${page}`}
                />
              </div>
            </div>
          ) : (
            <p className="muted" style={{ padding: "12px 6px" }}>
              Loading detail sheet…
            </p>
          )}
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

      {visiblePages.length > 1 && !fullScreen && (
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
            {view === "details" ? "PDF page" : "Floor"} {page} · {pageIndex + 1} /{" "}
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
        {isLead && (
          <span>
            <i style={{ background: VOIDED_RING_COLOR }} /> install undone
          </span>
        )}
      </div>

      {legendInstallers.length > 0 && (
        <div className="map-legend map-legend--installers muted">
          <span className="map-legend__label">Assigned to:</span>
          {legendInstallers.map((inst) => (
            <span key={inst.id}>
              <i className="map-legend__initials" style={{ background: inst.color }}>
                {installerInitials(inst.name)}
              </i>{" "}
              {inst.name}
            </span>
          ))}
        </div>
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
