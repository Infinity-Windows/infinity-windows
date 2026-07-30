import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { listProjects, listWindowTypes } from "../../lib/api";
import {
  aiExtractSchedule,
  assignOpeningToInstaller,
  downloadPlanset,
  elevationAppearancesFromDoc,
  ensureTypesFromSpecs,
  linkSpecsToOpenings,
  listElevationViews,
  listMarkSpecs,
  listOpenings,
  listPlanOutlines,
  listPlansets,
  listProfiles,
  listVoidedInstallOpeningIds,
  saveDraftOpenings,
  saveElevationViews,
  savePlanOutline,
  setOpeningsSequence,
  unassignOpening,
  undoInstall,
  updateOpening,
} from "../../lib/install/api";
import {
  OpeningDetailCard,
  VOIDED_RING_COLOR,
} from "../../components/install/OpeningDetailCard";
import { OpeningRowButton } from "../../components/install/OpeningRowButton";
import {
  showsVoidedInstall,
  toggleExpandedOpening,
} from "../../lib/install/openingRowAction";
import { openingUnitKind } from "../../lib/install/unitKind";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { useRealtimeOpenings } from "../../lib/useRealtimeOpenings";
import { invalidateOpeningQueries } from "../../lib/install/openingQueryKeys";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import {
  isForemanPlus,
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
  mergePageLists,
  splitCalloutsByFloorPlan,
  type PdfTextPage,
} from "../../lib/install/planDetails";
import {
  extractScheduleRows,
  rowsToDraftOpenings,
  calloutsToDraftOpenings,
  summarizeDraftMarks,
  summarizeExtractOutcome,
  type ExtractOutcomeSummary,
} from "../../lib/install/extract";
import {
  outlinePathWithOpenings,
  parseOutlineFeatures,
} from "../../lib/install/cad";
import { formatApiError } from "../../lib/install/errors";
import {
  extractBuildingOutline,
  outlinePathD,
  perimeterPositions,
  type BuildingOutline,
} from "../../lib/install/outline";
import {
  resolveFootprint,
  type FootprintSource,
} from "../../lib/install/footprint";
import { separatePins } from "../../lib/install/pinLayout";
import {
  snapOpeningsToWalls,
  wallPinPosition,
  type SnappedOpening,
} from "../../lib/install/wallSnap";
import { MapPinLayer } from "./MapPinLayer";
import { MapWallLayer } from "./MapWallLayer";
import { OutlineFeatureLayer } from "./OutlineFeatureLayer";
import { PlanModelEditor } from "./PlanModelEditor";
import { PlansPanel } from "./PlansPanel";

function isUsablePdf(ps: Planset): boolean {
  return ps.source_format === "pdf" || !!ps.converted_pdf_path;
}

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

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Target centre-to-centre pin spacing, as a fraction of page width. An 18px dot
 * on a 390px phone is ~0.046 of the page, so this leaves a hair of daylight
 * between neighbours.
 */
const PIN_MIN_GAP = 0.05;

/** Above this many marks on a page, numbers are off unless asked for. */
const PIN_LABEL_AUTO_MAX = 14;

/**
 * Wall thickness in viewBox units (page width = 1000), so it scales with the
 * sheet. Roughly 4px on a 390px phone: a wall you can see, not a hairline.
 */
const WALL_STROKE = 11;

/**
 * What the sheet header says about where the shape came from. "from the marks"
 * is honest about being approximate without implying something is broken — it
 * is a normal, permanent state for a job nobody has traced.
 */
const FOOTPRINT_SOURCE_LABEL: Record<FootprintSource | "none", string> = {
  saved: "traced by hand",
  traced: "outline from CAD",
  pins: "shape from marks",
  none: "no marks placed yet",
};

/**
 * A stored outline may be one the app derived and saved for itself. The origin
 * is stamped into `features.derived_from`, so a saved shape reports where it
 * actually came from instead of crediting a person who never drew it.
 */
function savedFootprintLabel(features: unknown): string {
  const origin =
    features && typeof features === "object"
      ? (features as { derived_from?: unknown }).derived_from
      : undefined;
  if (origin === "pins" || origin === "traced") {
    return FOOTPRINT_SOURCE_LABEL[origin];
  }
  return FOOTPRINT_SOURCE_LABEL.saved;
}

export function ProjectMap({ embedded = false }: { embedded?: boolean }) {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();
  // Standalone /map is its own route, so it needs its own subscription; when
  // embedded, ProjectDetail already has one and a second would be a duplicate.
  useRealtimeOpenings(embedded ? undefined : projectId);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<DrawingView>("outline");
  const [floorPages, setFloorPages] = useState<number[]>([]);
  const [buildingPageCount, setBuildingPageCount] = useState(0);
  const [specsPageCount, setSpecsPageCount] = useState(0);
  const [specsText, setSpecsText] = useState<PdfTextPage[]>([]);
  const [image, setImage] = useState<PageImage | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [filter, setFilter] = useState<PlanFilter>("all");
  const [fullScreen, setFullScreen] = useState(false);
  const [pdfZoom, setPdfZoom] = useState(1);
  /** null = decide from how busy the page is; true/false = the user decided. */
  const [markNumbers, setMarkNumbers] = useState<boolean | null>(null);
  const buildingDocRef = useRef<PDFDocumentProxy | null>(null);
  const specsDocRef = useRef<PDFDocumentProxy | null>(null);
  const [docsReady, setDocsReady] = useState(0);

  // Cartoon plan state: per-page traced outlines, selection, drag.
  const [outlines, setOutlines] = useState<Record<number, BuildingOutline | null>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The list below the drawing expands its own details. Kept separate from the
  // pin selection so opening a row doesn't move anything on the map, and so the
  // same card can never render twice at once.
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
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
  const [extractSummary, setExtractSummary] =
    useState<ExtractOutcomeSummary | null>(null);
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
        return openingUnitKind(o) === "window";
      case "doors":
        return openingUnitKind(o) === "door";
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
  // The specs we already read off the sheets are the surest sign of which pages
  // hold window/door information, whoever the supplier is.
  const markSpecs = useQuery({
    queryKey: ["markSpecs", projectId],
    queryFn: () => listMarkSpecs(projectId),
    enabled: !!projectId,
  });
  // Where each mark is drawn on the elevation sheets — reference pictures for
  // the pin details, and the check that tells us whether this job has them yet.
  const elevationViews = useQuery({
    queryKey: ["elevationViews", projectId],
    queryFn: () => listElevationViews(projectId),
    enabled: !!projectId,
  });
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

  /**
   * Which spec pages carry window/door details. Text rules alone kept 3 of Black
   * Desert's 14 pages; the 37 specs already read off 11 of them say otherwise, so
   * the extracted specs get a vote. A spec with no recorded planset is from
   * before that column existed (Smith's live drawings) — counted, matching
   * `isDrawingStale`, because it is unknown provenance rather than wrong.
   */
  const details = useMemo(
    () =>
      extractCadDetailPages(
        specsText,
        (markSpecs.data ?? []).filter(
          (spec) => !spec.planset_id || spec.planset_id === specsPdf?.id,
        ),
      ),
    [specsText, markSpecs.data, specsPdf?.id],
  );

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
      setExtractSummary(null);
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
        setSpecsText(pages);
        specsDocRef.current = doc;
        setSpecsPageCount(doc.numPages);
      }

      let drafts;
      let repeatViewCallouts = 0;
      let elevationViews = 0;
      if (buildingPdf) {
        setExtractNote("Reading mark callouts on the building plan…");
        const buildingDoc = await loadPdf(await downloadPlanset(buildingPdf));
        const callouts = await extractPlanMarkCallouts(buildingDoc);
        if (callouts.length > 0) {
          // Elevation sheets re-number the same windows the floor plan already
          // numbers; only the floor drawings decide the opening count. The
          // repeats are kept as a reference — where each window sits outside.
          const split = splitCalloutsByFloorPlan(
            callouts,
            await extractAllText(buildingDoc),
          );
          repeatViewCallouts = split.repeatViewCallouts.length;
          elevationViews = (
            await saveElevationViews(
              projectId,
              buildingPdf.id,
              await elevationAppearancesFromDoc(buildingDoc),
            )
          ).saved;
          drafts = calloutsToDraftOpenings(
            split.planCallouts,
            rows,
            types.data ?? [],
          );
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
      return {
        result,
        source,
        marks: summarizeDraftMarks(drafts),
        repeatViewCallouts,
        elevationViews,
      };
    },
    onSuccess: ({ result, source, marks, repeatViewCallouts, elevationViews }) => {
      invalidateOpeningQueries(queryClient, projectId);
      queryClient.invalidateQueries({ queryKey: ["windowTypes"] });
      queryClient.invalidateQueries({ queryKey: ["elevationViews", projectId] });
      setExtractNote(null);
      setExtractSummary(
        summarizeExtractOutcome({
          marks,
          inserted: result.inserted,
          skipped: result.skipped,
          repeatViewCallouts,
          elevationViews,
          source,
        }),
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
        const { extractAllText, extractPlanMarkCallouts, loadPdf } =
          await import("../../lib/install/pdf");
        let initialPage = 1;

        if (buildingPdf) {
          const buildingDoc = await loadPdf(await downloadPlanset(buildingPdf));
          const buildingText = await extractAllText(buildingDoc);
          if (cancelled) return;
          buildingDocRef.current = buildingDoc;
          setBuildingPageCount(buildingDoc.numPages);
          // Marked plans carry their numbers as annotations, which the text
          // layer never shows — count those too or an annotation-marked
          // supplier looks like it has one numbered drawing.
          const buildingCallouts = await extractPlanMarkCallouts(buildingDoc);
          const detectedFloorPages = findFloorPlanPages(
            buildingText,
            buildingCallouts,
          );
          setFloorPages(detectedFloorPages);
          initialPage = detectedFloorPages[0] ?? 1;
        }

        if (specsPdf) {
          const specsDoc = await loadPdf(await downloadPlanset(specsPdf));
          const specsPageText = await extractAllText(specsDoc);
          if (cancelled) return;
          specsDocRef.current = specsDoc;
          setSpecsPageCount(specsDoc.numPages);
          setSpecsText(specsPageText);
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

  /**
   * Jobs whose plans were read before the elevation reference existed have
   * openings but no reference rows, and nobody is going to re-upload a planset
   * to get pictures. The building PDF is already open in this tab, so read them
   * off it once, in the background, the first time a lead opens the map.
   *
   * Deliberately narrow: leads only (installers cannot write these rows), only
   * when this planset has none stored, once per planset per visit, and silent on
   * failure. It cannot touch openings — it writes one table, and that table is
   * read by nothing that counts.
   */
  const backfilledElevations = useRef<string | null>(null);
  const buildingPdfId = buildingPdf?.id ?? null;
  const storedElevations = elevationViews.data;
  useEffect(() => {
    if (!isLead || !buildingPdfId || !elevationViews.isFetched) return;
    const doc = buildingDocRef.current;
    if (!doc) return;
    if (backfilledElevations.current === buildingPdfId) return;
    if ((storedElevations ?? []).some((row) => row.planset_id === buildingPdfId)) {
      return;
    }
    backfilledElevations.current = buildingPdfId;
    let cancelled = false;
    void (async () => {
      try {
        const appearances = await elevationAppearancesFromDoc(doc);
        if (cancelled || appearances.length === 0) return;
        const { saved } = await saveElevationViews(
          projectId,
          buildingPdfId,
          appearances,
        );
        if (!cancelled && saved > 0) {
          queryClient.invalidateQueries({
            queryKey: ["elevationViews", projectId],
          });
        }
      } catch {
        // Reference material. A plan we can't read this way just has no pictures.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isLead,
    buildingPdfId,
    elevationViews.isFetched,
    storedElevations,
    docsReady,
    projectId,
    queryClient,
  ]);

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
        : /*
           * The outline view pages by the sheets the PDF reader thinks are floor
           * plans, PLUS any sheet that actually carries marks. Oakridge's marks
           * are on page 1 while its detected floor sheets are 3 and 4, so this
           * view used to draw a building with nothing on it and offer no way to
           * reach the marks at all. A page with marks on it is a page a crew
           * needs, whatever the detector concluded.
           */
          mergePageLists(floorPages, pinnedPlanPages, buildingPageCount);
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
  const manualOutline: BuildingOutline | null = useMemo(
    () =>
      manualOutlineRow
        ? {
            points: manualOutlineRow.points,
            pageAspect: manualOutlineRow.page_aspect,
          }
        : null,
    [manualOutlineRow],
  );
  /**
   * The marks already placed on this page, which is what the building shape is
   * derived from when nothing better exists. Deliberately taken from `all`
   * rather than `filtered`: the building must not change shape when someone
   * taps "Doors" or "Done".
   */
  const pagePins = useMemo(
    () =>
      (openings.data ?? [])
        .filter(
          (o) => o.pin_x !== null && o.pin_y !== null && o.page_number === page,
        )
        .map((o) => ({ x: o.pin_x as number, y: o.pin_y as number })),
    [openings.data, page],
  );
  const pageAspectHint =
    manualOutline?.pageAspect ?? extractedOutline?.pageAspect ?? 0.7;
  // saved outline -> coarsened PDF trace -> shape traced from this job's pins.
  const footprint = useMemo(
    () =>
      resolveFootprint({
        saved: manualOutline,
        traced: extractedOutline,
        pins: pagePins,
        aspect: pageAspectHint,
      }),
    [manualOutline, extractedOutline, pagePins, pageAspectHint],
  );
  const outline = footprint?.outline ?? null;
  const outlineLoading =
    view === "outline" &&
    !manualOutline &&
    outlines[page] === undefined &&
    !planOutlines.isLoading;
  const aspect = outline?.pageAspect ?? pageAspectHint;

  /**
   * Save the shape once, the first time a lead opens a page that has none.
   *
   * The pin-derived footprint is cheap but not free — a grid trace per page, on
   * a phone, thrown away on every visit. Storing it makes the shape stable, and
   * gives a lead something to correct by hand later.
   *
   * Same narrow contract as the elevation backfill: leads only, only when
   * nothing is stored, once per page per visit, silent on failure. It also
   * waits until every mark on the job has a pin, so a half-pinned job does not
   * freeze a half-sized building.
   *
   * The lead gate is this client only — `project_plan_outlines` currently
   * grants every authenticated user full access — so it keeps one crew member's
   * phone from writing shapes for the whole company, not a security boundary.
   */
  const backfilledFootprint = useRef<string | null>(null);
  const footprintPoints = footprint?.outline.points;
  const footprintSource = footprint?.source ?? null;
  const fullyPinned =
    (openings.data ?? []).length > 0 &&
    (openings.data ?? []).every((o) => o.pin_x !== null && o.pin_y !== null);
  useEffect(() => {
    if (!isLead || !buildingPlansetId || !planOutlines.isFetched) return;
    if (!footprintPoints || !footprintSource || footprintSource === "saved") {
      return;
    }
    if (!fullyPinned) return;
    const key = `${buildingPlansetId}:${page}`;
    if (backfilledFootprint.current === key) return;
    backfilledFootprint.current = key;
    let cancelled = false;
    void (async () => {
      try {
        await savePlanOutline({
          projectId,
          plansetId: buildingPlansetId,
          pageNumber: page,
          points: footprintPoints,
          pageAspect: aspect,
          // Remembering the origin keeps the header honest: a shape derived
          // from marks must not later claim someone traced it by hand.
          features: { derived_from: footprintSource },
        });
        if (!cancelled) {
          queryClient.invalidateQueries({
            queryKey: ["planOutlines", projectId],
          });
        }
      } catch {
        // Best-effort. The shape is recomputed from the pins next visit.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isLead,
    buildingPlansetId,
    planOutlines.isFetched,
    footprintPoints,
    footprintSource,
    fullyPinned,
    page,
    aspect,
    projectId,
    queryClient,
  ]);

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
  /** What the supplier's specs PDF says about this opening's mark, if anything. */
  const specDetailFor = (o: ProjectOpening) =>
    details.find((d) =>
      d.marks.includes(openingMarkCode(o.opening_code)),
    ) ?? null;

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

  /**
   * The pin details, and the same card the list rows open below themselves.
   * `onClose` differs because the two are opened independently — closing the
   * card under a list row must not clear the pin selected on the drawing.
   */
  const renderDetailCard = (
    o: ProjectOpening,
    { onClose, id }: { onClose: () => void; id?: string },
  ) => (
    <OpeningDetailCard
      projectId={projectId}
      opening={o}
      voided={showsVoidedInstall(effectiveRole, o, voidedIds)}
      installerColor={o.assignee ? crewColors.get(o.assignee.id) : undefined}
      detail={specDetailFor(o)}
      onClose={onClose}
      onOpenDetailSheet={(pageNumber) => showView("details", pageNumber)}
      id={id}
    />
  );

  /**
   * A window is a hole in a wall, so a mark already sitting on a wall is drawn
   * as an opening in it rather than a dot floating nearby.
   *
   * Only marks close to a wall qualify. The rest — most of Pecan's floor 3,
   * where the extractor dumped marks in rows across the middle of the page —
   * stay exactly where they are. Cutting a hole in a wall for one of those would
   * state a position the data does not have.
   *
   * The pin being dragged is excluded, so it follows the finger and re-snaps on
   * release instead of jumping to a wall mid-drag.
   */
  const wallOpenings = (() => {
    const empty = {
      snapped: new Map<string, SnappedOpening>(),
      freeIds: [] as string[],
    };
    if (!outline || editingModel || manualOutlinePaths.length > 0) return empty;
    return snapOpeningsToWalls({
      openings: [...placed, ...autos]
        .filter((o) => o.id !== drag?.id)
        .map((o) => {
          const pos = dotPos(o);
          return {
            id: o.id,
            x: pos.x,
            y: pos.y,
            kind: openingUnitKind(o),
          };
        }),
      points: outline.points,
      aspect,
    });
  })();

  /**
   * Where each pin is drawn. A wall opening's pin becomes the handle for that
   * opening and sits just inside the room, clear of the gap; everything else is
   * fanned apart for legibility only. Either way the stored pin_x/pin_y are
   * untouched, and dragging writes the position the finger lands on.
   */
  const pinPositions = (() => {
    const free: { id: string; x: number; y: number }[] = [];
    const handles = new Map<string, { x: number; y: number }>();
    for (const o of [...placed, ...autos]) {
      const opening = wallOpenings.snapped.get(o.id);
      const handle =
        opening && outline
          ? wallPinPosition(outline.points, aspect, opening)
          : null;
      if (handle) {
        handles.set(o.id, handle);
        continue;
      }
      const pos = dotPos(o);
      free.push({ id: o.id, x: pos.x, y: pos.y });
    }
    const layout = separatePins(free, { minDist: PIN_MIN_GAP, aspect });
    for (const [id, point] of handles) layout.set(id, point);
    // The pin under the finger sits exactly where the finger is. Nudging it, or
    // pulling it onto a wall mid-drag, would make dragging feel broken.
    if (drag) layout.set(drag.id, { x: drag.x, y: drag.y });
    return layout;
  })();

  const autoPinIds = new Set(autos.map((o) => o.id));

  /**
   * Wall openings are drawn in their install status colour, the same encoding the
   * pins use. Off-route openings fall back to the wall colour while a foreman is
   * building a run, so the route is what stands out.
   */
  const wallOpeningColor = (id: string): string | undefined => {
    const opening = [...placed, ...autos].find((o) => o.id === id);
    if (!opening) return undefined;
    if (hasRoute && routeOrder.get(id) == null) return undefined;
    if (showsVoidedInstall(effectiveRole, opening, voidedIds)) {
      return VOIDED_RING_COLOR;
    }
    return OPENING_STATUS_COLORS[opening.status];
  };

  /**
   * Mark numbers are legible until the page gets busy — Black Desert has 42 on
   * one sheet, which is 42 overlapping words. Past that they are off until
   * someone asks for them or zooms in, and the selected pin is always labelled.
   */
  const markCount = placed.length + autos.length;
  const labelsFitOnPage = markCount <= PIN_LABEL_AUTO_MAX;
  const showMarkNumbers = markNumbers ?? (labelsFitOnPage || pdfZoom >= 1.5);

  const renderOpeningDots = (mode: "all" | "pinned" = "all") => (
    <MapPinLayer
      openings={mode === "pinned" ? placed : [...placed, ...autos]}
      positions={pinPositions}
      autoIds={autoPinIds}
      selectedId={selectedId}
      draggingId={drag?.id ?? null}
      dispatchMode={dispatchMode}
      selection={selection}
      routeOrder={routeOrder}
      routeNewIds={routeNewIds}
      hasRoute={hasRoute}
      crewColors={crewColors}
      voidedIds={voidedIds}
      effectiveRole={effectiveRole}
      showMarkNumbers={showMarkNumbers}
      pinTitle={pinTitle}
      onPinPointerDown={beginDrag}
    />
  );

  // Reset zoom when flipping PDF pages.
  useEffect(() => {
    setPdfZoom(1);
  }, [page, view]);

  /*
   * And open on a sheet that has marks. The detector picked page 3 for Oakridge,
   * whose three marks are on page 1, so the first thing that view showed was an
   * empty building. Once only, so it never fights someone paging around.
   */
  const openedMarkedPage = useRef(false);
  useEffect(() => {
    // docsReady, not the page list: it is bumped in the same commit as the
    // planset's own choice of opening page, so this cannot be overwritten by it.
    if (openedMarkedPage.current || docsReady === 0) return;
    if (pinnedPlanPages.length === 0) return;
    openedMarkedPage.current = true;
    if (!pinnedPlanPages.includes(page)) setPage(pinnedPlanPages[0]);
  }, [docsReady, page, pinnedPlanPages]);


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

          <PlansPanel
            buildingPdfs={buildingPdfs}
            specsPdfs={specsPdfs}
            buildingPdf={buildingPdf}
            specsPdf={specsPdf}
            activePlanset={activePlanset}
            view={view}
            page={page}
            floorPages={floorPages}
            details={details}
            extractNote={extractNote}
            extractSummary={extractSummary}
            reextractPending={reextractSpecs.isPending}
            onReextract={() => reextractSpecs.mutate()}
            onPickBuildingPlanset={(id: string) => {
              setBuildingPlansetId(id);
              setView("outline");
              setOutlines({});
              setFullScreen(false);
            }}
            onPickSpecsPlanset={(id: string) => {
              setSpecsPlansetId(id);
              setView("details");
              setFullScreen(false);
            }}
            onShowView={showView}
          />
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
        {/*
          On a busy sheet the numbers are off by default. This is the escape
          hatch for when you do want to read them, and it sits with the filters
          because it filters what a pin shows.
        */}
        <button
          type="button"
          className={showMarkNumbers ? "chip active" : "chip"}
          aria-pressed={showMarkNumbers}
          onClick={() => setMarkNumbers(!showMarkNumbers)}
          title="Show or hide mark numbers on the pins"
        >
          Numbers
        </button>
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
            {/*
             * Just the job. The view is already named by the view buttons above
             * the sheet, and spelling it out here too wrapped this header onto
             * three lines on a phone with the separator stranded on its own.
             */}
            <span className="cartoon-sheet__title">
              {project?.job_code ?? "PLAN"}
            </span>
            <div className="cartoon-sheet__head-actions">
              <span className="cartoon-sheet__status">
                {editingModel
                  ? "editing model"
                  : outlineLoading
                    ? "tracing plan…"
                    : footprint?.source === "saved"
                      ? savedFootprintLabel(manualOutlineRow?.features)
                      : FOOTPRINT_SOURCE_LABEL[footprint?.source ?? "none"]}
              </span>
              {!editingModel && (
                <button
                  type="button"
                  className="button-like"
                  aria-label="Edit model"
                  onClick={() => {
                    setEditingModel(true);
                    setFullScreen(false);
                  }}
                >
                  Edit
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
                /**
                 * The aspect is set in fullscreen too. Pins are positioned as
                 * percentages of THIS element while walls are drawn inside the
                 * SVG, so the two only agree while the box keeps the viewBox's
                 * aspect — letting it stretch is what distorted the building.
                 */
                style={{ aspectRatio: `1 / ${aspect}` }}
              >
                <svg
                  viewBox={`0 0 1000 ${Math.round(1000 * aspect)}`}
                  preserveAspectRatio="xMidYMid meet"
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
                  ) : (
                    outlinePath &&
                    outline && (
                      <MapWallLayer
                        points={outline.points}
                        aspect={aspect}
                        outlinePath={outlinePath}
                        openings={[...wallOpenings.snapped.values()]}
                        colorFor={wallOpeningColor}
                        selectedId={selectedId}
                        wallStroke={WALL_STROKE}
                      />
                    )
                  )}
                </svg>
                {renderOpeningDots()}
                <div className="cartoon-sheet__floor" aria-hidden>
                  Floor {page}
                  <span>
                    {placed.length + autos.length} mark
                    {placed.length + autos.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
              {selectedOpening &&
                renderDetailCard(selectedOpening, {
                  onClose: () => setSelectedId(null),
                })}
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
              {project?.job_code ?? "PLAN"}
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
          {selectedOpening &&
            renderDetailCard(selectedOpening, {
              onClose: () => setSelectedId(null),
            })}
        </div>
      )}

      {view === "details" && (
        <div
          className={`plan-sheet${fullScreen ? " plan-sheet--fullscreen" : ""}`}
        >
          {fullScreen && fullscreenBar}
          <div className="cartoon-sheet__head">
            <span className="cartoon-sheet__title">
              {project?.job_code ?? "PLAN"}
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

      {/*
        One legend, and it explains exactly what a pin now encodes: colour for
        status, square for a door. Installer colours only appear while dispatch
        is open, which is the only time pins carry them.
      */}
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
        <span>
          <i className="map-legend__door" /> door
        </span>
        {isLead && (
          <span>
            <i
              className="map-legend__voided"
              style={{ borderColor: VOIDED_RING_COLOR }}
            />{" "}
            install undone
          </span>
        )}
        {dispatchMode &&
          legendInstallers.map((inst) => (
            <span key={inst.id}>
              <i
                className="map-legend__initials"
                style={{ background: inst.color }}
              >
                {installerInitials(inst.name)}
              </i>{" "}
              {inst.name}
            </span>
          ))}
      </div>

      <h2>
        {filter === "all" ? "All openings" : FILTERS.find((f) => f.id === filter)?.label}{" "}
        ({filtered.length})
      </h2>
      <p className="muted opening-list-hint">
        Tap a window or door to see its details.
      </p>
      <ul className="unit-list work-list">
        {filtered.map((o) => {
          const isVoided = showsVoidedInstall(effectiveRole, o, voidedIds);
          const panelId = `opening-row-panel-${o.id}`;
          const expanded = expandedRowId === o.id;
          return (
          <li key={o.id} className="find-row">
            <OpeningRowButton
              openingCode={o.opening_code}
              expanded={expanded}
              panelId={panelId}
              onToggle={() =>
                setExpandedRowId((prev) => toggleExpandedOpening(prev, o.id))
              }
            >
              <span
                className="unit-dot"
                aria-hidden
                style={{
                  background:
                    openingUnitKind(o) === "door" ? "var(--ok)" : "var(--info)",
                }}
              />
              <strong>{o.opening_code}</strong>
              <span className="muted">
                {o.window_types?.type_code ?? "type?"} {o.label ?? ""}
              </span>
              <span
                className="big-address"
                style={{ color: isVoided ? VOIDED_RING_COLOR : OPENING_STATUS_COLORS[o.status] }}
              >
                {isVoided ? "redo needed" : o.status}
              </span>
            </OpeningRowButton>
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
            {expanded && (
              <div className="opening-row-panel">
                {renderDetailCard(o, {
                  onClose: () => setExpandedRowId(null),
                  id: panelId,
                })}
              </div>
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
