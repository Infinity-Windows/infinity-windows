import { BackChip } from "../../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listProjects, listWindowTypes } from "../../lib/api";
import {
  ensureTypesFromSpecs,
  getPlansetSignedUrl,
  linkSpecsToOpenings,
  listPlansetPageProgress,
  listPlansets,
  plansetFormatFromName,
  plansetIsViewable,
  elevationAppearancesFromDoc,
  runSpecExtraction,
  saveDraftOpenings,
  saveElevationViews,
  updatePlanset,
  uploadPlanset,
  downloadPlanset,
  type SpecExtractionOptions,
} from "../../lib/install/api";
import { readScheduleFromDoc } from "../../lib/install/scheduleRead";
import {
  describeSpecPages,
  failedSpecPages,
  formatPageList,
  type SpecPageStatus,
} from "../../lib/install/specPageStatus";
import {
  canResumeExtraction,
  pendingPages,
  summarizeProgress,
  type StoredPageProgress,
} from "../../lib/install/extractionProgress";
import { ExtractionProgress } from "../../components/install/ExtractionProgress";
import {
  calloutsToDraftOpenings,
  rowsToDraftOpenings,
  summarizeDraftMarks,
  summarizeExtractOutcome,
} from "../../lib/install/extract";
import { formatApiError } from "../../lib/install/errors";
import { syncProjectSignatures } from "../../lib/estimate/signatureSync";
import {
  extractCadDetailPages,
  splitCalloutsByFloorPlan,
} from "../../lib/install/planDetails";
import { isForemanPlus, type Planset, type PlansetKind } from "../../lib/install/types";
import { claimUnsavedWork } from "../../lib/pwa/unsavedWork";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { useT } from "../../lib/i18n";
import { jobDocumentAssetIds } from "../../lib/jobDocuments";
import {
  fileSizeLabel,
  filesNewOnMonday,
  filesOnMonday,
  guessMondayFileKind,
  isExtractableFile,
  mondayJobForProject,
  pullMondayFiles,
  type MondayFileKind,
} from "../../lib/mondaySync";
import { PlansetViewer } from "./PlansetViewer";

function fileName(ps: Planset): string {
  return ps.storage_path.split("/").pop() ?? ps.storage_path;
}

export function PlansetUpload() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Planset | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  // How the last spec extraction went, page by page. Kept so a page whose
  // vision call failed is SAID OUT LOUD (and can be retried on its own) instead
  // of looking exactly like a page with no marks on it.
  const [specPages, setSpecPages] = useState<{
    plansetId: string;
    pages: SpecPageStatus[];
    visionFailed: boolean;
  } | null>(null);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  // Which planset this tab is actively reading, and where it has got to. The
  // durable copy lives in `project_planset_pages`; this is just what's on
  // screen between saves.
  const [runningPlansetId, setRunningPlansetId] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<number | null>(null);
  const [livePages, setLivePages] = useState<StoredPageProgress[] | null>(null);
  const cancelRun = useRef(false);

  const t = useT();
  const { effectiveRole } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);
  // Which Monday file the office is pointing at each slot, and which pull is
  // running. Keyed by asset id; seeded from the guesser as the list renders.
  const [mondayKinds, setMondayKinds] = useState<Record<string, MondayFileKind>>({});
  const [mondayNote, setMondayNote] = useState<string | null>(null);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const project = projects.data?.find((p) => p.id === projectId);
  const plansets = useQuery({
    queryKey: ["plansets", projectId],
    queryFn: () => listPlansets(projectId),
  });
  const types = useQuery({ queryKey: ["windowTypes"], queryFn: listWindowTypes });

  // The staged Monday row this job was built from, if there is one. Both
  // queries degrade to nothing when their table or column is not there yet, so
  // a phone ahead of the migration still opens this page.
  const mondayJob = useQuery({
    queryKey: ["mondayJobForProject", projectId],
    queryFn: () => mondayJobForProject(projectId),
    enabled: isLead && !!projectId,
  });
  const documentAssetIds = useQuery({
    queryKey: ["jobDocumentAssetIds", projectId],
    queryFn: () => jobDocumentAssetIds(projectId),
    enabled: isLead && !!projectId,
  });

  const building = (plansets.data ?? []).filter(
    (p) => (p.kind ?? "building") === "building",
  );
  const specs = (plansets.data ?? []).filter((p) => p.kind === "specs");
  // Newest specs planset — the one a progress bar or resume applies to.
  const currentSpecs = specs[0] ?? null;

  const storedProgress = useQuery({
    queryKey: ["plansetProgress", currentSpecs?.id],
    queryFn: () => listPlansetPageProgress(currentSpecs!.id),
    enabled: !!currentSpecs,
    // Cheap, and lets a second device watch a run happening elsewhere.
    refetchInterval: currentSpecs?.status === "extracting" ? 5000 : false,
  });

  const pagesForBar = livePages ?? storedProgress.data ?? [];
  const progressTotal = currentSpecs?.page_count ?? 0;
  const barProgress = summarizeProgress(progressTotal, pagesForBar);
  const resumable =
    !!currentSpecs &&
    canResumeExtraction(currentSpecs, runningPlansetId, currentSpecs.id);

  /**
   * Read a specs planset page by page, saving progress as it goes. Shared by
   * the upload path and Resume so an interrupted run is finished by exactly the
   * code that started it.
   */
  const runExtraction = useCallback(
    async (
      planset: Planset,
      opts: Pick<SpecExtractionOptions, "pages" | "doc"> = {},
    ) => {
      cancelRun.current = false;
      setRunningPlansetId(planset.id);
      try {
        return await runSpecExtraction(projectId, planset, {
          ...opts,
          isCancelled: () => cancelRun.current,
          onTick: ({ pageNumber, status, progress }) => {
            setActivePage(status ? null : pageNumber);
            setLivePages(progress);
          },
        });
      } finally {
        setRunningPlansetId(null);
        setActivePage(null);
        queryClient.invalidateQueries({ queryKey: ["plansets", projectId] });
        queryClient.invalidateQueries({ queryKey: ["plansetProgress", planset.id] });
        queryClient.invalidateQueries({ queryKey: ["markSpecs", projectId] });
      }
    },
    [projectId, queryClient],
  );

  // A run only exists in this tab, so closing it abandons the run. Progress is
  // already saved page by page — this just stops someone losing five minutes by
  // accident. The persistence is the fix; this is the courtesy.
  useEffect(() => {
    if (!runningPlansetId) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    // Same courtesy towards the PWA update flow, which would otherwise be
    // entitled to reload a backgrounded app out from under a running extraction.
    const release = claimUnsavedWork();
    return () => {
      window.removeEventListener("beforeunload", warn);
      release();
    };
  }, [runningPlansetId]);

  /**
   * Read a planset that is already stored: marks off a building plan, or the
   * whole schedule-and-specs run off a specs sheet.
   *
   * Lifted out of the upload path unchanged (Monday files, F5) so that a file
   * the SERVER put here — pulled from the job's Monday item, and therefore
   * never read by anybody's browser — can be read by exactly the code that
   * reads a hand upload. Without this a pulled plan set would sit on this page
   * looking fine with nothing behind it on the map, which is indistinguishable
   * from a broken extraction.
   */
  const readPlanset = async (
    planset: Planset,
    kind: PlansetKind,
    bytes: ArrayBuffer,
  ) => {
      const { extractAllText, extractPlanMarkCallouts, loadPdf } = await import(
        "../../lib/install/pdf"
      );
      const doc = await loadPdf(bytes);
      await updatePlanset(planset.id, {
        status: kind === "specs" ? "extracting" : "ready",
        page_count: doc.numPages,
      });

      // Marked building plans carry FreeText callouts (#6 ×12, etc.).
      if (kind === "building") {
        setProgress("Reading mark callouts on the building plan…");
        const callouts = await extractPlanMarkCallouts(doc);
        if (callouts.length === 0) {
          return {
            planset,
            kind,
            drafts: 0,
            skipped: 0,
            linked: 0,
            converted: true,
          };
        }
        // Elevation sheets re-number the same windows the floor plan already
        // numbers, so only the floor drawings decide how many openings there
        // are. The repeats are not waste: they are where each window sits on the
        // building, which is the one thing a floor plan cannot show a crew.
        const { planCallouts, repeatViewCallouts } = splitCalloutsByFloorPlan(
          callouts,
          await extractAllText(doc),
        );
        const elevationViews = await saveElevationViews(
          projectId,
          planset.id,
          await elevationAppearancesFromDoc(doc),
        );
        let drafts = calloutsToDraftOpenings(planCallouts, [], types.data ?? []);
        drafts = await ensureTypesFromSpecs(drafts);
        const linked = await linkSpecsToOpenings(projectId, drafts);
        const result = await saveDraftOpenings(projectId, planset.id, drafts);
        const marks = summarizeDraftMarks(drafts);
        return {
          planset,
          kind,
          drafts: result.inserted,
          skipped: result.skipped,
          linked: linked.linked,
          converted: true,
          source: "details" as const,
          marks,
          unmatchedPlanMarks: result.unmatchedPlanMarks,
          repeatViewCallouts: repeatViewCallouts.length,
          elevationViews: elevationViews.saved,
        };
      }

      setProgress("Extracting window/door schedule…");
      const pages = await extractAllText(doc);
      const catalog = (types.data ?? []).map((t) => ({
        type_code: t.type_code,
        name: t.name,
      }));
      const read = await readScheduleFromDoc(doc, pages, catalog, setProgress);
      const { rows, source, unreadPages } = read;

      let drafts = rowsToDraftOpenings(rows, types.data ?? []);
      setProgress("Linking marks to types…");
      drafts = await ensureTypesFromSpecs(drafts);
      const linked = await linkSpecsToOpenings(projectId, drafts);
      const result = await saveDraftOpenings(projectId, planset.id, drafts, { specsAuthoritative: ["vision", "deterministic", "ai"].includes(source) });

      // Pull the FULL per-mark line-item specs (style/glass/color/…) via Claude
      // VISION off the rendered page images — manufacturer shop drawings draw
      // the spec table as graphics, so the image is the only way to recover
      // glass/color/style. Deterministic text parsing is the offline fallback.
      //
      // Page by page, saving progress after each one: the sheet can take
      // minutes, and before this a foreman who walked away left the planset
      // wedged in 'extracting' with nothing to show for the pages that HAD been
      // read. The runner also retires the superseded planset and takes this row
      // out of 'extracting' once every page has been attempted.
      setProgress("Reading detailed window/door specs…");
      const run = await runExtraction(
        { ...planset, page_count: doc.numPages },
        { doc },
      );
      const specsResult = {
        saved: run.saved,
        pages: run.pages as SpecPageStatus[],
        visionFailed: run.pages.length > 0 && run.pages.every((p) => !p.ok),
      };

      const marks = summarizeDraftMarks(drafts);
      // A page counts as a detail sheet if its text reads like one OR the
      // extraction actually pulled specs off it. The text rules only know the
      // `#mark` habit and a handful of Smith's phrases, so on Black Desert they
      // saw 3 pages where 11 hold real window drawings.
      const detailSheets = new Set([
        ...extractCadDetailPages(pages).map((d) => d.pageNumber),
        ...specsResult.pages
          .filter((p) => p.markCount > 0)
          .map((p) => p.pageNumber),
      ]);
      return {
        planset,
        kind,
        drafts: result.inserted,
        skipped: result.skipped,
        linked: linked.linked,
        specs: specsResult.saved,
        specPages: specsResult.pages,
        specsVisionFailed: specsResult.visionFailed,
        converted: true,
        source,
        unreadPages,
        marks,
        detailSheets: detailSheets.size,
      };
  };

  const upload = useMutation({
    mutationFn: async (args: { file: File; kind: PlansetKind }) => {
      const { file, kind } = args;
      const format = plansetFormatFromName(file.name);
      if (!format) throw new Error("Choose a PDF, DWG, or DXF file.");

      setSummary(null);
      setProgress(
        kind === "building"
          ? "Uploading building plan…"
          : "Uploading specs / schedule…",
      );
      const planset = await uploadPlanset(projectId, file, kind);

      if (format !== "pdf") {
        return {
          planset,
          kind,
          drafts: 0,
          skipped: 0,
          linked: 0,
          converted: false,
        };
      }

      return readPlanset(planset, kind, await file.arrayBuffer());
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["plansets", projectId] });
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
      queryClient.invalidateQueries({ queryKey: ["windowTypes"] });
      queryClient.invalidateQueries({ queryKey: ["markSpecs", projectId] });
      setProgress(null);
      setRetryNote(null);
      setSpecPages(
        "specPages" in result
          ? {
              plansetId: result.planset.id,
              pages: result.specPages ?? [],
              visionFailed: Boolean(result.specsVisionFailed),
            }
          : null,
      );
      const detailSheetCount =
        "detailSheets" in result ? (result.detailSheets ?? 0) : 0;

      if (result.kind === "building") {
        if (!result.converted) {
          setSummary("Building plan stored. CAD conversion is queued.");
          return;
        }
        if ("marks" in result && result.marks?.length) {
          const outcome = summarizeExtractOutcome({
            marks: result.marks,
            inserted: result.drafts,
            skipped: result.skipped,
            repeatViewCallouts:
              "repeatViewCallouts" in result
                ? (result.repeatViewCallouts ?? 0)
                : 0,
            elevationViews:
              "elevationViews" in result ? (result.elevationViews ?? 0) : 0,
            source: "none",
          });
          const unmatched =
            "unmatchedPlanMarks" in result ? (result.unmatchedPlanMarks ?? []) : [];
          setSummary(
            [
              `Building plan ready. ${outcome.headline}`,
              ...outcome.notes,
              unmatched.length > 0
                ? `Plan label${unmatched.length > 1 ? "s" : ""} with no CAD window behind ${unmatched.length > 1 ? "them" : "it"}: ${unmatched.map((m) => `#${m}`).join(", ")} — nothing was created for ${unmatched.length > 1 ? "these" : "it"}; check the plans against the signed CADs.`
                : null,
            ]
              .filter(Boolean)
              .join(" "),
          );
          return;
        }
        setSummary(
          "Building plan ready for the map. Upload specs or use Load marks on the map.",
        );
        return;
      }

      if (!result.converted) {
        setSummary("Specs file stored. CAD conversion is queued.");
        return;
      }

      if (result.drafts > 0 || result.linked > 0) {
        const markLine =
          "marks" in result && result.marks?.length
            ? summarizeExtractOutcome({
                marks: result.marks,
                inserted: result.drafts,
                skipped: result.skipped,
                repeatViewCallouts: 0,
                elevationViews: 0,
                source: "none",
              }).headline
            : null;
        const sourceNote =
          "source" in result && result.source === "vision"
            ? "Counted the pictured cut-sheet cells with a QTY value."
            : "source" in result && result.source === "details"
              ? "Pulled from manufacturer detail sheets."
              : "source" in result && result.source === "merged"
                ? "Merged schedule table with detail-sheet marks."
                : null;
        const unreadNote =
          "unreadPages" in result && result.unreadPages?.length
            ? `Could not read page${result.unreadPages.length > 1 ? "s" : ""} ${result.unreadPages.join(", ")} — check ${result.unreadPages.length > 1 ? "those pages" : "that page"} by hand.`
            : null;
        const specsSaved = "specs" in result ? (result.specs ?? 0) : 0;
        setSummary(
          [
            markLine,
            sourceNote,
            unreadNote,
            result.drafts > 0 ? `${result.drafts} draft openings.` : null,
            result.linked > 0 ? `Linked types on ${result.linked} existing openings.` : null,
            specsSaved > 0 ? `Read detailed specs for ${specsSaved} mark(s).` : null,
          ]
            .filter(Boolean)
            .join(" "),
        );
        navigate(`/projects/${projectId}/review`);
      } else if (detailSheetCount > 0) {
        setSummary(
          `Indexed ${detailSheetCount} manufacturer detail sheets from the PDF. Open the map to view them beside the 2D floor plan.`,
        );
        navigate(`/projects/${projectId}?tab=map`);
      } else {
        setSummary(
          "PDF saved as a source document. No schedule rows or marked detail sheets were found.",
        );
      }
    },
    onError: (e) => setProgress(formatApiError(e)),
  });

  /**
   * Read a planset the SERVER put here.
   *
   * A pull writes the row and the bytes and stops — no browser has ever opened
   * the file, so a pulled plan set arrives at status 'uploaded' with no marks
   * behind it. This is the button that reads it, running exactly the code an
   * upload runs. Without it a pulled plan is dead weight on this page.
   */
  const readNow = useMutation({
    mutationFn: async (ps: Planset) => {
      setSummary(null);
      setProgress(
        (ps.kind ?? "building") === "building"
          ? "Reading mark callouts on the building plan…"
          : "Reading the window/door schedule…",
      );
      return readPlanset(ps, ps.kind ?? "building", await downloadPlanset(ps));
    },
    onSuccess: (result) => {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["plansets", projectId] });
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
      queryClient.invalidateQueries({ queryKey: ["windowTypes"] });
      queryClient.invalidateQueries({ queryKey: ["markSpecs", projectId] });
      setSummary(
        `Read ${result.drafts} draft opening(s)${
          result.skipped > 0 ? `, ${result.skipped} kept as they were` : ""
        }.`,
      );
    },
    onError: (e) => {
      setProgress(null);
      setSummary(formatApiError(e));
    },
  });

  /** Bring one file across from the job's Monday item. Never automatic. */
  const pullFromMonday = useMutation({
    mutationFn: async (args: { assetId: string; kind: MondayFileKind }) => {
      const job = mondayJob.data;
      if (!job) throw new Error("This job is not linked to a Monday job.");
      setMondayNote(null);
      return pullMondayFiles({
        mondayJobId: job.id,
        projectId,
        files: [{ asset_id: args.assetId, kind: args.kind }],
      });
    },
    onSuccess: (r) => {
      const one = r.results[0];
      setMondayNote(
        one?.ok
          ? one.already
            ? t("mondayFiles.result.already")
            : one.where === "plans"
              ? t("mondayFiles.result.toPlans")
              : one.where === "specs"
                ? t("mondayFiles.result.toSpecs")
                : t("mondayFiles.result.toDocuments")
          : one?.error?.trim() || r.error?.trim() || t("mondayFiles.result.failed"),
      );
      queryClient.invalidateQueries({ queryKey: ["plansets", projectId] });
      queryClient.invalidateQueries({ queryKey: ["jobDocuments", projectId] });
      queryClient.invalidateQueries({ queryKey: ["jobDocumentAssetIds", projectId] });
    },
    onError: (e) => setMondayNote(formatApiError(e)),
  });

  // Re-read only the pages that failed (or the whole sheet when the vision call
  // itself died). Nothing already saved is at risk: the save path never
  // overwrites a confirmed mark and a fresh failure just changes nothing.
  /**
   * Pick a stopped run back up. Resumes at the first page that never completed
   * (and retries any that failed), so nothing already extracted is redone —
   * this is what un-sticks a planset left in `extracting` by someone navigating
   * away mid-run, without anyone editing the database.
   */
  const resumeExtraction = useMutation({
    mutationFn: async () => {
      if (!currentSpecs) throw new Error("No specs file on this job yet.");
      const left = pendingPages(
        currentSpecs.page_count ?? 0,
        storedProgress.data ?? [],
      );
      setRetryNote(
        left.length > 0
          ? `Picking up at page ${left[0]} of ${currentSpecs.page_count ?? "?"}…`
          : "Checking the specs sheet…",
      );
      return runExtraction(currentSpecs);
    },
    onSuccess: (result) => {
      const stillFailed = failedSpecPages(result.pages as SpecPageStatus[]);
      setSpecPages({
        plansetId: currentSpecs?.id ?? "",
        pages: result.pages as SpecPageStatus[],
        visionFailed: false,
      });
      setRetryNote(
        result.stopped
          ? "Stopped. Everything read so far is saved — resume any time."
          : stillFailed.length > 0
            ? `Still couldn't read page ${formatPageList(stillFailed)}. Try again in a minute, or fill those marks in by hand on the review screen.`
            : `Done — specs saved for ${result.saved} mark(s).`,
      );
    },
    onError: (e) => setRetryNote(formatApiError(e)),
  });

  /**
   * Re-read the WHOLE specs sheet with the current extractor — how existing
   * jobs pick up newly-extracted detail (per-panel widths, 90° corners).
   * Confirmed marks are never touched; unconfirmed rows (including
   * unconfirmed hand edits) are replaced by the fresh read.
   */
  const rereadSpecs = useMutation({
    mutationFn: async () => {
      if (!currentSpecs) throw new Error("No specs file on this job yet.");
      setRetryNote("Re-reading every specs page (panel widths + corners)…");
      const { reextractSpecPages } = await import("../../lib/install/api");
      return reextractSpecPages(projectId, currentSpecs);
    },
    onSuccess: (result) => {
      setRetryNote(
        `Re-read done — specs refreshed for ${result.saved} mark(s). Confirmed marks were left untouched.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["markSpecs", projectId] });
      // Fresh panel/corner/inset reads change cohort keys.
      void syncProjectSignatures(projectId);
    },
    onError: (e) => setRetryNote(formatApiError(e)),
  });

  // Re-read the window list from a planset that is ALREADY stored — the fix
  // for "the extraction got it wrong" without hunting down the original file.
  // Confirmed marks and marks with field work are never touched (the same
  // supersede rules as an upload); everything else is replaced by the fresh
  // vision-first read.
  const rereadList = useMutation({
    mutationFn: async (ps: Planset) => {
      setSummary(null);
      setProgress("Re-reading the window list from this planset…");
      const { loadPdf, extractAllText } = await import("../../lib/install/pdf");
      const doc = await loadPdf(await downloadPlanset(ps));
      const pages = await extractAllText(doc);
      const catalog = (types.data ?? []).map((t) => ({
        type_code: t.type_code,
        name: t.name,
      }));
      const read = await readScheduleFromDoc(doc, pages, catalog, setProgress);
      let drafts = rowsToDraftOpenings(read.rows, types.data ?? []);
      setProgress("Linking marks to types…");
      drafts = await ensureTypesFromSpecs(drafts);
      const linked = await linkSpecsToOpenings(projectId, drafts);
      const result = await saveDraftOpenings(projectId, ps.id, drafts, {
        specsAuthoritative: ["vision", "deterministic", "ai"].includes(read.source),
      });
      return {
        inserted: result.inserted,
        skipped: result.skipped,
        linked: linked.linked,
        unreadPages: read.unreadPages,
        marks: summarizeDraftMarks(drafts),
      };
    },
    onSuccess: (r) => {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
      queryClient.invalidateQueries({ queryKey: ["plansets", projectId] });
      queryClient.invalidateQueries({ queryKey: ["windowTypes"] });
      queryClient.invalidateQueries({ queryKey: ["markSpecs", projectId] });
      const unread = r.unreadPages.length
        ? ` Could not read page${r.unreadPages.length > 1 ? "s" : ""} ${r.unreadPages.join(", ")} — check ${r.unreadPages.length > 1 ? "those pages" : "that page"} by hand.`
        : "";
      setSummary(
        `Window list re-read: ${r.inserted} draft opening(s) written${
          r.skipped > 0 ? `, ${r.skipped} kept as they were (confirmed or has field work)` : ""
        }.${unread} Review and confirm.`,
      );
      navigate(`/projects/${projectId}/review`);
    },
    onError: (e) => {
      setProgress(null);
      setSummary(formatApiError(e));
    },
  });

  const specPageNote = specPages
    ? specPages.visionFailed
      ? "We couldn't read the detailed specs off this sheet at all — only the basics were saved."
      : describeSpecPages(specPages.pages)
    : null;

  // Show the bar whenever there is something real to report: a live run, a
  // planset parked mid-extraction, or stored progress from a previous run.
  const showProgressBar =
    !!currentSpecs &&
    (runningPlansetId === currentSpecs.id ||
      resumable ||
      barProgress.attempted > 0);

  /**
   * Files Monday has on this job that the app does not.
   *
   * Foreman+ only, and empty for everyone else — this route is already a
   * foreman+ route, and the gate is restated here so the block cannot outlive
   * that guard if the page is ever reachable another way. Nothing is pulled
   * until somebody taps Get: the owner's decision (2026-09-04) was that a file
   * appearing on Monday is a thing to be TOLD about, never a thing that quietly
   * lands on a job.
   */
  const newOnMonday = isLead
    ? filesNewOnMonday(filesOnMonday(mondayJob.data ?? { files: null }), [
        ...(plansets.data ?? []).map((ps) => ps.source_asset_id),
        ...(documentAssetIds.data ?? []),
      ])
    : [];

  const openPlanset = async (ps: Planset) => {
    setViewError(null);
    if (plansetIsViewable(ps)) {
      setViewing(ps);
      return;
    }
    // DWG/DXF without a converted PDF — offer a download link instead.
    try {
      const url = await getPlansetSignedUrl(ps);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setViewError(formatApiError(e));
    }
  };

  if (viewing) {
    return (
      <div className="page">
        <PlansetViewer planset={viewing} onClose={() => setViewing(null)} />
      </div>
    );
  }

  const slot = (kind: PlansetKind, title: string, blurb: string, list: Planset[]) => (
    <section className="planset-slot" key={kind}>
      <h2>{title}</h2>
      <p className="muted">{blurb}</p>
      <label className="action-btn primary" style={{ cursor: "pointer" }}>
        {upload.isPending ? "Working…" : `Upload ${kind === "building" ? "building plan" : "specs"}`}
        <input
          type="file"
          accept=".pdf,.dwg,.dxf,application/pdf"
          style={{ display: "none" }}
          disabled={upload.isPending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate({ file, kind });
            e.target.value = "";
          }}
        />
      </label>
      <ul className="unit-list">
        {list.map((ps) => (
          <li key={ps.id} className="planset-row">
            <button
              type="button"
              className="planset-open"
              onClick={() => void openPlanset(ps)}
            >
              <strong>{fileName(ps)}</strong>
              <span className="muted">
                {" "}
                {ps.source_format.toUpperCase()}
                {ps.status === "converting"
                  ? " · conversion queued"
                  : ps.status === "extracting"
                    ? runningPlansetId === ps.id
                      ? " · reading now"
                      : " · extraction stopped — resume below"
                    : ` · ${ps.status}`}
                {ps.page_count ? ` · ${ps.page_count} pages` : ""}
              </span>
              <span className="planset-open-cta">
                {plansetIsViewable(ps) ? "View ›" : "Download ›"}
              </span>
            </button>
            {/* Where this file came from. Worth one small word: a plan set
                nobody in the office remembers uploading is a plan set somebody
                will otherwise go looking for the upload of. */}
            {ps.source_asset_id && (
              <span className="muted" style={{ fontSize: 11 }} data-testid="from-monday">
                {t("mondayFiles.fromMonday")}
              </span>
            )}
            {/* A file the server put here has never been opened by a browser,
                so it is still 'uploaded' and nothing has been read off it. */}
            {ps.status === "uploaded" && plansetIsViewable(ps) && (
              <button
                type="button"
                className="link"
                data-testid="read-planset"
                disabled={readNow.isPending || upload.isPending}
                onClick={() => readNow.mutate(ps)}
              >
                {readNow.isPending && readNow.variables?.id === ps.id
                  ? t("mondayFiles.extracting")
                  : t("mondayFiles.extract")}
              </button>
            )}
            {kind === "specs" && ps.status === "ready" && plansetIsViewable(ps) && (
              <button
                type="button"
                className="link"
                disabled={rereadList.isPending || upload.isPending}
                onClick={() => rereadList.mutate(ps)}
              >
                {rereadList.isPending && rereadList.variables?.id === ps.id
                  ? "Re-reading…"
                  : "Re-read window list"}
              </button>
            )}
          </li>
        ))}
        {list.length === 0 && <p className="muted">Nothing in this slot yet.</p>}
      </ul>
    </section>
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Plansets</p>
          <h1>{project?.job_code ?? "Upload"}</h1>
        </div>
        <BackChip fallback={`/projects/${projectId}?tab=map`} label="Map" />
      </header>

      <p className="muted">
        Two slots per job: the building plan for the map, and the specs/schedule
        that defines each mark (#14 → size, color, type). Tap a file to view it.
        Confirm drafts before they drive inventory.
      </p>

      {slot(
        "building",
        "Building plan",
        "Floor drawings with #14 / #6 marks at openings. Used as the map background.",
        building,
      )}
      {slot(
        "specs",
        "Specs / schedule",
        "Window & door schedule table — mark, size, type, color. Creates/links openings.",
        specs,
      )}

      {newOnMonday.length > 0 && (
        <section className="planset-slot" data-testid="files-on-monday">
          <h2>{t("mondayFiles.new.heading")}</h2>
          <p className="muted">{t("mondayFiles.new.blurb")}</p>
          <ul className="unit-list">
            {newOnMonday.map((f) => {
              const locked = !isExtractableFile(f.name, f.ext);
              const kind = locked
                ? "document"
                : mondayKinds[f.asset_id] ?? guessMondayFileKind(f.name, f.ext);
              const size = fileSizeLabel(f.size);
              const busy =
                pullFromMonday.isPending &&
                pullFromMonday.variables?.assetId === f.asset_id;
              return (
                <li key={f.asset_id} className="find-row" style={{ flexWrap: "wrap", gap: 6 }}>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    {f.name}
                    {size && <span className="muted" style={{ fontSize: 11.5 }}> · {size}</span>}
                  </span>
                  <select
                    value={kind}
                    disabled={locked || pullFromMonday.isPending}
                    aria-label={`${f.name} — ${t("mondayFiles.new.heading")}`}
                    onChange={(e) =>
                      setMondayKinds((prev) => ({
                        ...prev,
                        [f.asset_id]: e.target.value as MondayFileKind,
                      }))
                    }
                  >
                    <option value="building">{t("mondayFiles.kind.building")}</option>
                    <option value="specs">{t("mondayFiles.kind.specs")}</option>
                    <option value="document">{t("mondayFiles.kind.document")}</option>
                  </select>
                  <button
                    type="button"
                    className="button-like active-pill"
                    data-testid="pull-from-monday"
                    disabled={pullFromMonday.isPending}
                    onClick={() =>
                      pullFromMonday.mutate({ assetId: f.asset_id, kind })
                    }
                  >
                    {busy ? t("mondayFiles.new.pulling") : t("mondayFiles.new.pull")}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {mondayNote && (
        <p className="ok" data-testid="monday-pull-note">
          {mondayNote}
        </p>
      )}

      {progress && <p className="scanner-hint">{progress}</p>}
      {summary && <p className="ok">{summary}</p>}
      {viewError && <p className="error">{viewError}</p>}

      {showProgressBar && (
        <ExtractionProgress
          progress={barProgress}
          activePage={activePage}
          onStop={
            runningPlansetId ? () => { cancelRun.current = true; } : undefined
          }
          onResume={
            resumable && !resumeExtraction.isPending
              ? () => resumeExtraction.mutate()
              : undefined
          }
          resuming={resumeExtraction.isPending}
          note={[specPageNote, retryNote].filter(Boolean).join(" ") || null}
        />
      )}

      {currentSpecs && currentSpecs.status !== "extracting" && (
        <div className="row-gap" style={{ marginTop: 12 }}>
          <button
            className="button-like"
            disabled={rereadSpecs.isPending}
            title="Re-read every specs page with the current extractor — picks up per-panel widths and 90° corners. Confirmed marks are never touched; unconfirmed edits are replaced."
            onClick={() => {
              if (
                window.confirm(
                  "Re-read the whole specs sheet? Confirmed marks stay as-is; unconfirmed marks (including unconfirmed hand edits) are replaced by the fresh read.",
                )
              ) {
                rereadSpecs.mutate();
              }
            }}
          >
            {rereadSpecs.isPending ? "Re-reading…" : "Re-read specs (panels + corners)"}
          </button>
        </div>
      )}

      <p className="muted" style={{ marginTop: 16 }}>
        After specs extract →{" "}
        <Link to={`/projects/${projectId}/review`}>Review openings</Link>
        {" · "}
        <Link to={`/projects/${projectId}?tab=map`}>Map</Link>
      </p>
    </div>
  );
}
