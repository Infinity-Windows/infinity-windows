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
  runSpecExtraction,
  saveDraftOpenings,
  updatePlanset,
  uploadPlanset,
  aiExtractSchedule,
  type SpecExtractionOptions,
} from "../../lib/install/api";
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
  describeMarkCount,
  extractScheduleRows,
  rowsToDraftOpenings,
  summarizeDraftMarks,
} from "../../lib/install/extract";
import { formatApiError } from "../../lib/install/errors";
import {
  calloutsOnFloorPlanSheets,
  extractCadDetailPages,
} from "../../lib/install/planDetails";
import type { Planset, PlansetKind } from "../../lib/install/types";
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

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const project = projects.data?.find((p) => p.id === projectId);
  const plansets = useQuery({
    queryKey: ["plansets", projectId],
    queryFn: () => listPlansets(projectId),
  });
  const types = useQuery({ queryKey: ["windowTypes"], queryFn: listWindowTypes });

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
    return () => window.removeEventListener("beforeunload", warn);
  }, [runningPlansetId]);

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

      const { extractAllText, extractPlanMarkCallouts, loadPdf } = await import(
        "../../lib/install/pdf"
      );
      const doc = await loadPdf(await file.arrayBuffer());
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
        // numbers, so only the floor drawings decide how many openings there are.
        const planCallouts = calloutsOnFloorPlanSheets(
          callouts,
          await extractAllText(doc),
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
          repeatViewCallouts: callouts.length - planCallouts.length,
        };
      }

      setProgress("Extracting window/door schedule…");
      const pages = await extractAllText(doc);
      const catalog = (types.data ?? []).map((t) => ({
        type_code: t.type_code,
        name: t.name,
      }));
      const { rows, source } = await extractScheduleRows(pages, async (pgs) => {
        try {
          setProgress("No schedule table found — checking PDF details…");
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
          // A manufacturer detail PDF can be useful without containing a
          // schedule table. Keep it available in the 2D source viewer.
          return [];
        }
      });

      let drafts = rowsToDraftOpenings(rows, types.data ?? []);
      setProgress("Linking marks to types…");
      drafts = await ensureTypesFromSpecs(drafts);
      const linked = await linkSpecsToOpenings(projectId, drafts);
      const result = await saveDraftOpenings(projectId, planset.id, drafts);

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
        marks,
        detailSheets: detailSheets.size,
      };
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
          const markLine = result.marks.map(describeMarkCount).join(", ");
          const repeats =
            "repeatViewCallouts" in result ? (result.repeatViewCallouts ?? 0) : 0;
          setSummary(
            [
              `Building plan ready. Loaded ${markLine} from plan callouts.`,
              repeats > 0
                ? `Ignored ${repeats} repeat number${repeats === 1 ? "" : "s"} on the elevation sheets — those draw the same openings again.`
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
            ? result.marks.map(describeMarkCount).join(", ")
            : null;
        const sourceNote =
          "source" in result && result.source === "details"
            ? "Pulled from manufacturer detail sheets."
            : "source" in result && result.source === "merged"
              ? "Merged schedule table with detail-sheet marks."
              : null;
        const specsSaved = "specs" in result ? (result.specs ?? 0) : 0;
        setSummary(
          [
            markLine ? `Found ${markLine}.` : null,
            sourceNote,
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
        <Link to={`/projects/${projectId}?tab=map`} className="back-chip" aria-label="Map">
          ‹
        </Link>
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

      <p className="muted" style={{ marginTop: 16 }}>
        After specs extract →{" "}
        <Link to={`/projects/${projectId}/review`}>Review openings</Link>
        {" · "}
        <Link to={`/projects/${projectId}?tab=map`}>Map</Link>
      </p>
    </div>
  );
}
