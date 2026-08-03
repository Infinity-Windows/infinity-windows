import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { listProjects, listWindowTypes } from "../../lib/api";
import {
  aiExtractSchedule,
  assignOpeningToInstaller,
  downloadPlanset,
  elevationAppearancesFromDoc,
  ensureTypesFromSpecs,
  getMyProfile,
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
import { openingUnitKindResolver } from "../../lib/install/unitKind";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { useRealtimeOpenings } from "../../lib/useRealtimeOpenings";
import { invalidateOpeningQueries } from "../../lib/install/openingQueryKeys";
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
import { planLoadMessage, withPlanTimeout } from "../../lib/install/planLoad";
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
import {
  matchesPlanFilter,
  resolveFilter,
  visibleFilters,
  type PlanFilter,
} from "../../lib/install/openingFilter";
import { dispatchNudge, dispatchNudgeText } from "../../lib/install/dispatchNudge";
import { MapPinLayer } from "./MapPinLayer";
import { MapWallLayer } from "./MapWallLayer";
import { movedMarkIds } from "../../lib/install/pinHistory";
import { PlanMarkUndoBar } from "../../components/install/PlanMarkUndoBar";
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

/** Outline = cartoon extract; building = original floor PDF; details = specs PDF. */
type DrawingView = "outline" | "building" | "details";

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Wall thickness in viewBox units (page width = 1000), so it scales with the
 * sheet. Roughly 4px on a 390px phone: a wall you can see, not a hairline.
 */
const WALL_STROKE = 11;

/**
 * The outline opens showing the whole floor. Zoom is for inspecting a corner,
 * not for fixing crowding: magnifying grows the wall and the openings in it by
 * the same amount, so a floor that looks packed at 100% looks just as packed at
 * 200%. What stops it looking packed is `MAX_OPENING_SLOT_SHARE` in wallSnap,
 * which keeps most of the wall as wall.
 */
const OUTLINE_ZOOM_DEFAULT = 1;
const OUTLINE_ZOOM_MIN = 1;
const OUTLINE_ZOOM_MAX = 4;

/**
 * What the sheet header says about where the shape came from. "from the marks"
 * is honest about being approximate without implying something is broken — it
 * is a normal, permanent state for a job nobody has traced.
 */
const FOOTPRINT_SOURCE_LABEL: Record<FootprintSource | "none", string> = {
  saved: "traced by hand",
  traced: "outline from CAD",
  pins: "basic outline",
  none: "no marks placed yet",
};

/**
 * A stored outline may be one the app derived and saved for itself. The origin
 * is stamped into `features.derived_from`, so a saved shape reports where it
 * actually came from instead of crediting a person who never drew it.
 */
function outlineDerivedFrom(features: unknown): FootprintSource | null {
  const origin =
    features && typeof features === "object"
      ? (features as { derived_from?: unknown }).derived_from
      : undefined;
  return origin === "pins" || origin === "traced" ? origin : null;
}

function savedFootprintLabel(features: unknown): string {
  const origin = outlineDerivedFrom(features);
  if (origin) return FOOTPRINT_SOURCE_LABEL[origin];
  return FOOTPRINT_SOURCE_LABEL.saved;
}

/**
 * An outline a person drew by hand. Auto-saved pin/trace shapes used to lock
 * in forever under this name, which is why Black Desert kept drawing a lumpy
 * "building" after the app had already moved on to a plain rectangle.
 */
function isHandDrawnOutline(features: unknown): boolean {
  return outlineDerivedFrom(features) === null;
}

export function ProjectMap({ embedded = false }: { embedded?: boolean }) {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();
  // Standalone /map is its own route, so it needs its own subscription; when
  // embedded, ProjectDetail already has one and a second would be a duplicate.
  useRealtimeOpenings(embedded ? undefined : projectId);
  const [page, setPage] = useState(1);
  /*
   * The real architectural sheet, not the derived cartoon. The cartoon opened
   * first for a while and it is the wrong thing to lead with: it is a plain
   * rectangle on every job nobody has traced by hand, so a crew looking for
   * "which window is this" got a box with marks around the edge instead of the
   * drawing the marks came off. The outline is still one tap away.
   */
  const [view, setView] = useState<DrawingView>("building");
  const [floorPages, setFloorPages] = useState<number[]>([]);
  const [buildingPageCount, setBuildingPageCount] = useState(0);
  const [specsPageCount, setSpecsPageCount] = useState(0);
  const [specsText, setSpecsText] = useState<PdfTextPage[]>([]);
  const [image, setImage] = useState<PageImage | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  // A plan that would not open, in words a crew member can act on. Separate
  // from `mapError` (which reports failed actions like saving a pin) because
  // this one owns the drawing area itself: while it is set the panel shows a
  // Retry button instead of a spinner that would otherwise never stop.
  const [planError, setPlanError] = useState<string | null>(null);
  // Bumped by Retry. Both the document load and the page render depend on it,
  // so one tap re-runs whichever stage failed.
  const [planAttempt, setPlanAttempt] = useState(0);
  const [filter, setFilter] = useState<PlanFilter>("all");
  const [fullScreen, setFullScreen] = useState(false);
  const [pdfZoom, setPdfZoom] = useState(1);
  /** Outline view zoom — independent of the PDF views, starts enlarged. */
  const [outlineZoom, setOutlineZoom] = useState(OUTLINE_ZOOM_DEFAULT);
  /** null = numbers on, the default; true/false = the user decided. */
  const [markNumbers, setMarkNumbers] = useState<boolean | null>(null);
  const buildingDocRef = useRef<PDFDocumentProxy | null>(null);
  const specsDocRef = useRef<PDFDocumentProxy | null>(null);
  const [docsReady, setDocsReady] = useState(0);

  // Cartoon plan state: per-page traced outlines, selection, drag.
  const [outlines, setOutlines] = useState<Record<number, BuildingOutline | null>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The list below the drawing expands its own details. Still its own state so
  // the same card can never render twice at once, but the two now move
  // together: see linkScroll.
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  /*
   * The list and the drawing answer each other's question: tapping row 23
   * highlights pin 23 on the sheet, and tapping a pin opens its row below.
   *
   * The counter matters: tapping the same row twice has to scroll twice, so an
   * identical target still re-fires the effect.
   */
  const [linkScroll, setLinkScroll] = useState<{
    to: "sheet" | "row";
    id: string;
    n: number;
  } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement | null>());
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
  // Window or door, from the description on the supplier's sheet. Built once
  // here so the pin, the filter chips, the list row and the detail card all
  // read the same answer.
  const unitKind = useMemo(
    () => openingUnitKindResolver(markSpecs.data ?? []),
    [markSpecs.data],
  );

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
  // "Mine" is about identity, not about the role being previewed, so it keys on
  // the real signed-in profile: an owner previewing "installer" still sees their
  // own openings rather than nobody's.
  const myProfile = useQuery({
    queryKey: ["myProfile"],
    queryFn: getMyProfile,
  });
  const myProfileId = myProfile.data?.id ?? null;
  const { effectiveRole } = useEffectiveRole();
  // Failed/undone-install markers are foreman+ only. Installers never see the
  // voided ring, legend, or "redo needed" state; the query is also gated so the
  // data is never fetched for a non-foreman (faithful under view-as preview too).
  const isLead = isForemanPlus(effectiveRole);
  // Where a mark sits is the whole crew's picture of the job, so nudging one is
  // a lead's call — the same bar as undoing it. The database enforces this on
  // its own (guard_opening_pin_move); this only decides whether the app offers
  // a gesture that would be refused.
  const canMoveMarks = isLead;
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
    setPlanError(null);
    (async () => {
      try {
        const { extractAllText, extractPlanMarkCallouts, loadPdf } =
          await import("../../lib/install/pdf");
        let initialPage = 1;

        if (buildingPdf) {
          const buildingDoc = await withPlanTimeout(
            downloadPlanset(buildingPdf).then(loadPdf),
          );
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
          const specsDoc = await withPlanTimeout(
            downloadPlanset(specsPdf).then(loadPdf),
          );
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
        // Owns the drawing area, so it reports through planError: the panel can
        // then offer Retry rather than sitting on "Loading original plan…".
        if (!cancelled) setPlanError(planLoadMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildingPdf?.id, specsPdf?.id, planAttempt]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setPlanError(null);
    withPlanTimeout(
      import("../../lib/install/pdf").then(({ renderPageImage }) =>
        renderPageImage(doc, page),
      ),
    )
      .then((img) => !cancelled && setImage(img))
      .catch((e) => !cancelled && setPlanError(planLoadMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [page, view, docsReady, planAttempt]);

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
    onError: (e, args) => {
      // Put the dot back where it was. Without this the optimistic position
      // outlives a refused write, so a mark the database never accepted still
      // looks moved until the next refresh — a silent no-op that reads as
      // success, which is exactly what a locked-down move must not do.
      setPending((prev) => {
        const { [args.id]: _refused, ...rest } = prev;
        return rest;
      });
      setMapError(formatApiError(e));
    },
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
  // Mine is hidden on a job the viewer has nothing on, so a foreman is never
  // offered a chip that can only ever show an empty list.
  const filters = visibleFilters(all, myProfileId);
  const activeFilter = resolveFilter(filter, filters);
  const filtered = all.filter((o) =>
    matchesPlanFilter(o, activeFilter, myProfileId, unitKind),
  );
  const nudge = dispatchNudge(all, { isLead, dispatchMode });
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
  const pageOutlineRows = useMemo(
    () =>
      (planOutlines.data ?? []).filter(
        (outline) => outline.page_number === page,
      ),
    [planOutlines.data, page],
  );
  // Only a hand-drawn shape overrides the rectangle. Auto-saved pin blobs and
  // CAD traces are hints the resolver already knows how to rebuild.
  const manualOutlineRows = useMemo(
    () => pageOutlineRows.filter((row) => isHandDrawnOutline(row.features)),
    [pageOutlineRows],
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
    !planOutlines.isLoading &&
    // Tracing needs the plan PDF. If that failed we fall back to the schematic
    // rather than sitting on "tracing plan…" for the rest of the shift.
    !planError;
  const aspect = outline?.pageAspect ?? pageAspectHint;

  /**
   * Save the shape once, the first time a lead opens a page that has none.
   *
   * A plain rectangle is cheap to rebuild, but storing it keeps the shape
   * stable across visits and gives a lead something to correct by hand later.
   * An older auto-saved pin blob is overwritten with the rectangle so a job
   * that once locked in a lumpy shape does not keep drawing it forever.
   *
   * Same narrow contract as the elevation backfill: leads only, only when
   * nothing hand-drawn is stored, once per page per visit, silent on failure.
   * It also waits until every mark on the job has a pin, so a half-pinned job
   * does not freeze a half-sized building.
   *
   * The lead gate is this client only — `project_plan_outlines` currently
   * grants every authenticated user full access — so it keeps one crew member's
   * phone from writing shapes for the whole company, not a security boundary.
   */
  const backfilledFootprint = useRef<string | null>(null);
  const footprintPoints = footprint?.outline.points;
  const footprintSource = footprint?.source ?? null;
  const autoOutlineId = pageOutlineRows.find(
    (row) => outlineDerivedFrom(row.features) !== null,
  )?.id;
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
          outlineId: autoOutlineId,
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
    (o: ProjectOpening) => (e: React.PointerEvent) => {
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
        // Below foreman the dot never leaves its spot, so the gesture stays a
        // tap however far the finger travels. Bailing here rather than skipping
        // the handler entirely is deliberate: tapping a mark to open its
        // details is the installer's main way around the plan, and that lives
        // in the same pointer session as the drag.
        if (!canMoveMarks) return;
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
          // A tap on a pin opens that opening's row below and scrolls to it, so
          // "what is this one" is answered without hunting the list for a code.
          // Only on the way in — deselecting leaves the list where it is.
          const next = selectedId === d.id ? null : d.id;
          setSelectedId(next);
          if (next) selectFromMap(next);
        }
        setDrag(null);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    };

  /** Pin tapped: open its row below and bring the row into view. */
  const selectFromMap = (id: string) => {
    setExpandedRowId(id);
    setLinkScroll((prev) => ({ to: "row", id, n: (prev?.n ?? 0) + 1 }));
  };

  /**
   * Row tapped: label its pin on the drawing and scroll the drawing back up.
   * The pin layer already labels whatever is selected, so one number appears on
   * demand instead of forty at all times.
   */
  const selectFromList = (o: ProjectOpening) => {
    setSelectedId(o.id);
    // Nothing to point at for an opening with no pin, or on the specs PDF,
    // which draws no pins — so don't yank the screen up to a drawing that
    // cannot answer the question.
    if (view === "details" || o.pin_x === null || o.pin_y === null) return;
    if (o.page_number != null && o.page_number !== page) setPage(o.page_number);
    setLinkScroll((prev) => ({ to: "sheet", id: o.id, n: (prev?.n ?? 0) + 1 }));
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
    setOutlineZoom(OUTLINE_ZOOM_DEFAULT);
  };

  const bumpZoom = (dir: 1 | -1) => {
    setPdfZoom((z) =>
      Math.min(4, Math.max(0.5, Math.round((z + dir * 0.25) * 100) / 100)),
    );
  };

  const bumpOutlineZoom = (dir: 1 | -1) => {
    setOutlineZoom((z) =>
      Math.min(
        OUTLINE_ZOOM_MAX,
        Math.max(
          OUTLINE_ZOOM_MIN,
          Math.round((z + dir * 0.25) * 100) / 100,
        ),
      ),
    );
  };

  const pinTitle = (o: ProjectOpening) =>
    `${openingMarkLabel(o.opening_code)}${o.window_types ? ` ${o.window_types.type_code}` : ""}${
      o.assignee
        ? ` — ${o.assignee.display_name}${o.sequence != null ? ` · #${o.sequence}` : ""}`
        : ""
    }`;

  const selectedOpening = all.find((o) => o.id === selectedId) ?? null;
  // Dots sitting somewhere other than where the plan put them, so the one that
  // was nudged by accident can be spotted instead of guessed at.
  const movedIds = movedMarkIds(all);
  // Undo for those moves. Foreman+ — the marks are the whole crew's view of
  // the job, so putting them back is a lead's call, and the database says so
  // too (the reset/undo functions check is_foreman_plus).
  const undoBar = isLead && project && (
    <PlanMarkUndoBar
      projectId={projectId}
      jobName={project.name}
      openings={all}
      selectedOpening={selectedOpening}
    />
  );

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
   * Where each pin is drawn: exactly where it is, and nowhere else.
   *
   * Overlapping pins used to be fanned apart along their cluster's axis to keep
   * a busy page countable. Every mark on Black Desert has a neighbour inside the
   * spacing threshold, so all 42 were pushed the full cap — about a tenth of the
   * sheet's width, 120px on a laptop — and none of them landed on the callout
   * number they belong to. Marks 1, 2 and 11 ended up off the building
   * altogether, out over the driveway.
   *
   * A pin that sits on the wrong window is worse than a pin that is hard to pick
   * out, because a crew reads position and only then reads the number. Crowding
   * is what zoom and tapping a row are for.
   */
  const pinPositions = new Map(
    [...placed, ...autos].map((o) => {
      const pos = dotPos(o);
      return [o.id, { x: pos.x, y: pos.y }] as const;
    }),
  );

  const autoPinIds = new Set(autos.map((o) => o.id));

  /**
   * Numbers are on. They were briefly auto-hidden above fourteen marks on a
   * page, which took the labels off every real job the company has — and the
   * number is the only thing that tells two identical windows apart. The
   * Numbers chip beside the filters turns them off for anyone who wants to.
   */
  const showMarkNumbers = markNumbers ?? true;

  const renderOpeningDots = (mode: "all" | "pinned" = "all") => {
    const shown = mode === "pinned" ? placed : [...placed, ...autos];
    return (
    <MapPinLayer
      openings={shown}
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
      unitKind={unitKind}
      canMoveMarks={canMoveMarks}
      movedIds={movedIds}
      pinTitle={pinTitle}
      onPinPointerDown={beginDrag}
    />
    );
  };

  // Reset zoom when flipping floors or switching views — start the outline
  // enlarged again rather than leaving a zoom from another page stuck on.
  useEffect(() => {
    setPdfZoom(1);
    setOutlineZoom(OUTLINE_ZOOM_DEFAULT);
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

  // Runs after the commit, so a row that just expanded is scrolled to at its
  // full height rather than to where it used to end.
  useEffect(() => {
    if (!linkScroll) return;
    const node =
      linkScroll.to === "sheet"
        ? sheetRef.current
        : rowRefs.current.get(linkScroll.id);
    if (!node) return;
    const still = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    )?.matches;
    node.scrollIntoView({
      behavior: still ? "auto" : "smooth",
      block: "nearest",
    });
  }, [linkScroll]);

  /**
   * Shown in the drawing area instead of a spinner when a plan will not open.
   * The wording is deliberately about what to DO, not about what broke: the
   * crew cannot fix a PDF, they can only tap Retry or ring the office.
   */
  const planTrouble = planError && (
    <div className="plan-trouble" role="alert">
      <p className="error">{planError}</p>
      <button
        type="button"
        className="button-like"
        onClick={() => {
          setPlanError(null);
          setPlanAttempt((attempt) => attempt + 1);
        }}
      >
        Retry
      </button>
    </div>
  );

  const pdfZoomControls = (view === "building" || view === "details") && (
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

  const outlineZoomControls = view === "outline" && (
    <div className="plan-zoom-controls" role="group" aria-label="Zoom">
      <button
        type="button"
        className="plan-zoom-btn"
        aria-label="Zoom out"
        disabled={outlineZoom <= OUTLINE_ZOOM_MIN}
        onClick={() => bumpOutlineZoom(-1)}
      >
        −
      </button>
      <button
        type="button"
        className="plan-zoom-btn plan-zoom-btn--label"
        aria-label="Reset zoom"
        title="Reset zoom"
        onClick={() => setOutlineZoom(OUTLINE_ZOOM_DEFAULT)}
      >
        {Math.round(outlineZoom * 100)}%
      </button>
      <button
        type="button"
        className="plan-zoom-btn"
        aria-label="Zoom in"
        disabled={outlineZoom >= OUTLINE_ZOOM_MAX}
        onClick={() => bumpOutlineZoom(1)}
      >
        +
      </button>
    </div>
  );

  const zoomControls = pdfZoomControls || outlineZoomControls;

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
            isLead={isLead}
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

      {/*
        Nobody has ever assigned work from this screen — not one opening in the
        company is sequenced — which reads as undiscovered rather than unwanted,
        since dispatch lives behind a toggle a lead has no reason to press. So
        say it out loud on a job where it would help, and stop the moment they
        assign anything.
      */}
      {nudge && (
        <div className="dispatch-nudge">
          <span>{dispatchNudgeText(nudge)}</span>
          <button
            type="button"
            className="chip"
            onClick={() => {
              setDispatchMode(true);
              setDispatchNote(null);
            }}
          >
            Hand them out
          </button>
        </div>
      )}

      <nav className="plan-filters" aria-label="Filter openings">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            className={activeFilter === f.id ? "chip active" : "chip"}
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
              {!fullScreen && !editingModel && outlineZoomControls}
              {/* Everything behind this button is plan authoring — drawing the
                  building outline and placing, renaming or removing marks. The
                  mark half is now foreman+ in the database, so leaving the
                  button up for installers would offer tools that refuse to
                  save. Nothing here is part of installing a window. */}
              {canMoveMarks && !editingModel && (
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
              {/* Outline is the view the map opens on, so the retry has to be
                  reachable from here and not only from the plan tab. */}
              {planTrouble}
              {/*
                Same scroll/pan pattern as the PDF views: the drawing is wider
                than the viewport at 200%, so neighbours get real space and the
                finger pans the sheet rather than squeezing everything to fit.
              */}
              <div
                className="plan-zoom-viewport plan-zoom-viewport--outline"
                onWheel={(e) => {
                  if (!e.ctrlKey && !e.metaKey) return;
                  e.preventDefault();
                  bumpOutlineZoom(e.deltaY < 0 ? 1 : -1);
                }}
              >
                <div
                  ref={sheetRef}
                  className="cartoon-sheet"
                  data-outline-zoom={outlineZoom}
                  /**
                   * Width is the zoom. Aspect stays locked so pin percentages
                   * and the SVG viewBox agree — stretching the box is what
                   * distorted the building before.
                   */
                  style={
                    {
                      width: `${outlineZoom * 100}%`,
                      aspectRatio: `1 / ${aspect}`,
                      "--sheet-aspect": aspect,
                    } as CSSProperties
                  }
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
                        /*
                         * Walls, and nothing in them. Marks used to be cut into
                         * this shape as window and door symbols instead of being
                         * drawn as pins, which took the numbers and the
                         * window/door colours off the map — and on a job with no
                         * hand-traced outline it cut 42 holes in a rectangle
                         * nobody drew. The marks are pins again, on top.
                         */
                        <MapWallLayer
                          points={outline.points}
                          aspect={aspect}
                          outlinePath={outlinePath}
                          selectedId={selectedId}
                          wallStroke={WALL_STROKE}
                        />
                      )
                    )}
                  </svg>
                  {renderOpeningDots("all")}
                  <div className="cartoon-sheet__floor" aria-hidden>
                    Floor {page}
                    <span>
                      {placed.length + autos.length} mark
                      {placed.length + autos.length === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
              </div>
              {undoBar}
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
          ) : planTrouble ? (
            planTrouble
          ) : (
            <p className="muted" style={{ padding: "12px 6px" }}>
              Loading original plan…
            </p>
          )}
          <p className="muted" style={{ marginTop: 8 }}>
            {canMoveMarks
              ? "Movable marks sit on the plan callouts. Zoom keeps them locked to those numbers — drag one to nudge it."
              : "Marks sit on the plan callouts. Zoom keeps them locked to those numbers. Tap one for its details — only a foreman can move them."}
          </p>
          {undoBar}
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
          ) : planTrouble ? (
            planTrouble
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
        One legend, and it explains exactly what a pin encodes: the number is
        the mark, the fill is window or door, the ring is how far along it is.
        Installer colours only appear while dispatch is open, which is the only
        time pins carry them.
      */}
      <div className="map-legend muted">
        <span>
          <i style={{ background: OPENING_KIND_COLORS.window }} /> window (#)
        </span>
        <span>
          <i
            className="map-legend__door"
            style={{ background: OPENING_KIND_COLORS.door }}
          />{" "}
          door (#)
        </span>
        {/* Status is the pin's ring, so the legend shows a ring, not a blob. */}
        <span>
          <i
            className="map-legend__ring"
            style={{ borderColor: OPENING_STATUS_COLORS.planned }}
          />{" "}
          planned
        </span>
        <span>
          <i
            className="map-legend__ring"
            style={{ borderColor: OPENING_STATUS_COLORS.assigned }}
          />{" "}
          assigned
        </span>
        <span>
          <i
            className="map-legend__ring"
            style={{ borderColor: OPENING_STATUS_COLORS.installed }}
          />{" "}
          installed
        </span>
        {isLead && (
          <span>
            <i
              className="map-legend__ring"
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
        {activeFilter === "all"
          ? "All openings"
          : activeFilter === "mine"
            ? "My openings"
            : filters.find((f) => f.id === activeFilter)?.label}{" "}
        ({filtered.length})
      </h2>
      <p className="muted opening-list-hint">
        Tap a window or door for its details, and to point it out on the
        drawing.
      </p>
      <ul className="unit-list work-list">
        {filtered.map((o) => {
          const isVoided = showsVoidedInstall(effectiveRole, o, voidedIds);
          const panelId = `opening-row-panel-${o.id}`;
          const expanded = expandedRowId === o.id;
          return (
          <li
            key={o.id}
            ref={(el) => {
              rowRefs.current.set(o.id, el);
            }}
            className={
              selectedId === o.id ? "find-row find-row--linked" : "find-row"
            }
          >
            <OpeningRowButton
              openingCode={o.opening_code}
              expanded={expanded}
              panelId={panelId}
              onToggle={() => {
                const next = toggleExpandedOpening(expandedRowId, o.id);
                setExpandedRowId(next);
                // Closing the row puts the drawing back to no label.
                if (next === o.id) selectFromList(o);
                else setSelectedId((prev) => (prev === o.id ? null : prev));
              }}
            >
              <span
                className="unit-dot"
                aria-hidden
                style={{
                  background:
                    unitKind(o) === "door" ? "var(--ok)" : "var(--info)",
                }}
              />
              <strong>{o.opening_code}</strong>
              <span className="muted">
                {o.window_types?.type_code ?? "type?"} {o.label ?? ""}
              </span>
              {/*
                Who owns this opening, without having to open the row first.
                Same initials and colour the dispatch legend uses, so a name
                reads the same wherever it appears.
              */}
              {o.assignee && (
                <span
                  className="row-assignee"
                  title={o.assignee.display_name}
                  style={{
                    background: crewColors.get(o.assignee.id) ?? "var(--muted)",
                  }}
                >
                  {installerInitials(o.assignee.display_name)}
                </span>
              )}
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
