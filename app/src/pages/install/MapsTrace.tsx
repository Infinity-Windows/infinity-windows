import { BackChip } from "../../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  applyPlacementSuggestions,
  discardLocalOutline,
  downloadPlanset,
  listMarkSpecs,
  listOpenings,
  listPlanOutlines,
  listPlansets,
  savePlanOutline,
  updateOpening,
} from "../../lib/install/api";
import { readPlacementsFromDoc } from "../../lib/install/placementRead";
import { listProjects } from "../../lib/api";
import { loadPdf } from "../../lib/install/pdf";
import { renderPageJpeg } from "../../lib/install/renderSpecImages";
import { extractSheetTextLines } from "../../lib/install/pdf";
import {
  detectPageStories,
  markPrefixStory,
  parseScaleNote,
  validateMarkPrefixes,
  type StoryDetection,
} from "../../lib/fitview/storyDetect";
import { formatApiError } from "../../lib/install/errors";
import { syncProjectSignatures } from "../../lib/estimate/signatureSync";
import { pushToast, toastSuccess } from "../../lib/toast";
import {
  buildAuthoredJob,
  buildFitViewJob,
  fitviewCalibration,
  fitviewModel,
  fitviewNorth,
  mergeFitviewWrite,
  normalizeMarkCode,
  openingIdForMark,
  preferModelOutline,
  type AuthoredModel,
} from "../../lib/fitview/adapter";
import {
  normalizedToPixel,
  pixelToNormalized,
  placementResultSummary,
  placementToastKind,
} from "../../lib/fitview/placementSuggestions";
import { mountTracePlan } from "../../lib/fitview/traceRenderer";
import { registerTrace, type TraceLike } from "../../lib/fitview/traceRegistration";
import "../../lib/fitview/fitview.css";
import "../../lib/fitview/trace.css";

/**
 * Trace the 3D model over the real plan sheet (foreman+). Ported from the
 * window-viewer prototype's trace.html: draw each building's outside walls,
 * calibrate against one known dimension, then drag the numbered dots onto
 * the walls — "Auto-place" seeds them straight from this job's extracted
 * opening pins, which is the by-hand step Ben's prototype needed a dots file
 * for. Submit writes the survey model into the outline row's
 * features.fitview.model, which Maps Interactive prefers wholesale.
 *
 * An existing outline row keeps its `points` untouched: those are aligned to
 * the plan sheet for the flat map's CAD view, and the tracer's meters-space
 * footprint is a different artifact that lives in features only.
 */
export function MapsTrace() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const project = projects.data?.find((p) => p.id === projectId);
  const outlines = useQuery({
    queryKey: ["planOutlines", projectId],
    queryFn: () => listPlanOutlines(projectId),
  });
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });
  const specs = useQuery({
    queryKey: ["markSpecs", projectId],
    queryFn: () => listMarkSpecs(projectId),
  });
  const plansets = useQuery({
    queryKey: ["plansets", projectId],
    queryFn: () => listPlansets(projectId),
  });

  // The model-bearing outline wins; the auto-extracted one is a fallback.
  const outline = preferModelOutline(outlines.data);
  // The underlay is the trader's choice (owner, 2026-08-14: "pull in the
  // spec sheet and the plan-set and let me toggle to the plan-set"): any
  // uploaded planset, any page — flip to the right floor-plan sheet for
  // the story being traced. Defaults to the building set's outline page.
  const [pickedPlansetId, setPickedPlansetId] = useState<string | null>(null);
  const [pickedPage, setPickedPage] = useState<number | null>(null);
  const plansPlanset = useMemo(() => {
    const all = plansets.data ?? [];
    return (
      (pickedPlansetId ? all.find((p) => p.id === pickedPlansetId) : null) ??
      all.find((p) => p.kind === "building") ??
      all[0] ??
      null
    );
  }, [plansets.data, pickedPlansetId]);
  const underlayPage = pickedPage ?? outline?.page_number ?? 1;
  // Vision placement (wave V-A) always reads the BUILDING planset's floor-plan
  // pages — the schedule marks it places are the plan's own marks, whichever
  // sheet the picker above happens to be showing right now.
  const buildingPlanset = useMemo(
    () => (plansets.data ?? []).find((p) => p.kind === "building") ?? null,
    [plansets.data],
  );

  // Vision placement (wave V-A): "Find placements" run state, shown next to
  // the sheet picker — the tracer toolbar itself is the vendored template,
  // so this progress/result line lives at the React level around it.
  const [placementRun, setPlacementRun] = useState<{
    status: "idle" | "reading" | "done";
    pages: number[];
    message: string | null;
    // Mirrors the toast's own kind so the line stays honest even after the
    // toast has faded — a zero-write result must still read as trouble, not
    // as the same quiet gray text a clean run leaves behind.
    kind: "success" | "error" | null;
  }>({ status: "idle", pages: [], message: null, kind: null });

  // The plan sheet as an image, rendered from the same planset the pins
  // live on. Dimensions ride along: pin coords are normalized, and both the
  // dot seed and trace re-registration need them in image pixels.
  const planImage = useQuery({
    queryKey: ["tracePlanImage", plansPlanset?.id, underlayPage],
    enabled: !!plansPlanset,
    staleTime: Infinity,
    queryFn: async () => {
      const bytes = await downloadPlanset(plansPlanset!);
      const doc = await loadPdf(bytes);
      const page = Math.min(underlayPage, doc.numPages);
      const pg = await doc.getPage(Math.max(1, page));
      const paperInchesWide = pg.getViewport({ scale: 1 }).width / 72;
      const url = await renderPageJpeg(doc, Math.max(1, page));
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("plan image failed to decode"));
        img.src = url;
      });
      // Phase 2: read every sheet's text and let the titles say which story
      // each page shows ("MAIN FLR FLOOR PLAN", "UPPER FLOOR PLAN"...).
      let detection: StoryDetection = { pages: [], stories: [], unresolved: [] };
      try {
        const lines = await extractSheetTextLines(doc);
        const byPage = new Map<number, string[]>();
        for (const l of lines) {
          if (!byPage.has(l.pageNumber)) byPage.set(l.pageNumber, []);
          byPage.get(l.pageNumber)!.push(l.text);
        }
        detection = detectPageStories(
          [...byPage.entries()].map(([pageNumber, ls]) => ({ pageNumber, lines: ls })),
        );
      } catch {
        /* a raster set with no text layer detects nothing — that is the
           honest outcome, not an error */
      }
      // Phase 3: the sheet often declares its own scale ("1/4\" = 1'-0\"").
      // With the paper size known, that makes manual calibration OPTIONAL.
      let scaleSuggestion: { metresPerPx: number; evidence: string } | null = null;
      try {
        const lines = await extractSheetTextLines(doc);
        const pageLines = lines
          .filter((l) => l.pageNumber === Math.max(1, page))
          .map((l) => l.text);
        const note =
          parseScaleNote(pageLines) ?? parseScaleNote(lines.map((l) => l.text));
        if (note && paperInchesWide > 0 && img.naturalWidth > 0) {
          const pxPerPaperInch = img.naturalWidth / paperInchesWide;
          scaleSuggestion = {
            metresPerPx: note.metresPerPaperInch / pxPerPaperInch,
            evidence: note.evidence,
          };
        }
      } catch {
        /* no text layer: no suggestion — calibrate by hand as before */
      }
      return { url, w: img.naturalWidth, h: img.naturalHeight, detection, scaleSuggestion };
    },
  });

  // Same job the Maps Interactive tab renders, so the tracer edits exactly
  // what the crew sees — authored model when it exists, pin-derived otherwise.
  const job = useMemo(() => {
    if (!project || !openings.data) return null;
    const meta = {
      projectId,
      projectName: project.name,
      projectAddress: project.address,
    };
    const authored = outline ? fitviewModel(outline.features) : null;
    if (authored) {
      const built = buildAuthoredJob(authored, meta, openings.data);
      // A stored trace was drawn over SOME image of this sheet — not
      // necessarily the one we just rendered. Its dots and our extracted
      // pins name the same marks, so when both exist, a best-fit similarity
      // moves the whole trace (polys, dots, calibration) onto our render.
      // A failed fit keeps the trace as stored; hands beat a wrong guess.
      const img = planImage.data;
      const trace = (built.building as { trace?: TraceLike }).trace;
      if (img && trace?.dots) {
        const targets: Record<string, { x: number; y: number }> = {};
        for (const o of openings.data) {
          if (o.pin_x == null || o.pin_y == null) continue;
          targets[normalizeMarkCode(o.opening_code)] = {
            x: o.pin_x * img.w,
            y: o.pin_y * img.h,
          };
        }
        const keyed: Record<string, { x: number; y: number }> = {};
        for (const id of Object.keys(trace.dots)) {
          const t = targets[normalizeMarkCode(id)];
          if (t) keyed[id] = t;
        }
        const registered = registerTrace(trace, keyed, img.w);
        if (registered) {
          (built.building as { trace?: TraceLike }).trace = {
            ...trace,
            ...registered,
          };
        }
      }
      return built;
    }
    if (!outline) {
      // No outline yet: an empty building plus the unit list — tracing from
      // scratch is exactly what this screen is for.
      return {
        id: projectId,
        ref: project.name,
        addr: project.address ?? "",
        rev: 1,
        building: { width: 0, depth: 0, height: 3.6, rise: 0, footprints: [] },
        windows: [],
      };
    }
    return buildFitViewJob({
      ...meta,
      outline: {
        points: outline.points,
        pageAspect: outline.page_aspect,
        pageNumber: outline.page_number,
      },
      openings: openings.data,
      specs: specs.data ?? [],
      ...fitviewCalibration(outline.features),
    });
  }, [project, outline, openings.data, specs.data, projectId, planImage.data]);

  // Staged writes from the tracer, applied only on Submit.
  const staged = useRef<{ building: AuthoredModel["building"] | null; upserts: Map<string, unknown> }>({
    building: null,
    upserts: new Map(),
  });

  const save = useMutation({
    mutationFn: async () => {
      const s = staged.current;
      const base = (outline ? fitviewModel(outline.features) : null) ?? {
        building: s.building!,
        windows: job?.windows ?? [],
      };
      const building = s.building ?? base.building;
      const byId = new Map<string, unknown>(
        (base.windows as { id: string }[]).map((w) => [String(w.id), w]),
      );
      for (const [id, w] of s.upserts) byId.set(id, w);

      const xs = building.footprints.flat().map((p) => p.x);
      const zs = building.footprints.flat().map((p) => p.z);
      const longSideM =
        xs.length > 1
          ? Math.max(
              Math.max(...xs) - Math.min(...xs),
              Math.max(...zs) - Math.min(...zs),
            )
          : undefined;

      // The three-writer footgun (CLAUDE.md): a submit that only knows
      // longSideM/wallHeightM/source/model must not wipe a sibling fitview
      // key it's never heard of — northDeg (wave N) today, whatever's next
      // tomorrow. mergeFitviewWrite spreads the PREVIOUS fitview object
      // first (ModelStudio.tsx's publish/revert precedent), so an unknown
      // key survives; a mixed-heights model's own story data is untouched
      // either way — it lives inside `model`, written whole below, never
      // flattened by this merge.
      const features = mergeFitviewWrite(outline?.features, {
        longSideM,
        wallHeightM: building.height,
        ...(building.northDeg != null ? { northDeg: building.northDeg } : {}),
        source: "in-app trace",
        model: { building, windows: [...byId.values()] },
      });

      // A browser-local draft (its id is not a UUID) cannot be UPDATED in
      // the database - Postgres rejects the fake id outright, which is
      // exactly the failure a submit used to die on. A real row updates in
      // place; a draft GRADUATES: submit inserts a fresh database row and
      // discards the local copy so it stops shadowing the saved one.
      const isRealRow =
        !!outline &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(outline.id);
      if (outline && isRealRow) {
        // Keep the row's plan-aligned points; only the survey model changes.
        return savePlanOutline({
          outlineId: outline.id,
          projectId,
          plansetId: outline.planset_id,
          pageNumber: outline.page_number,
          points: outline.points,
          pageAspect: outline.page_aspect,
          features,
        });
      }
      if (!plansPlanset) throw new Error("This job has no planset to attach the model to.");
      if (outline) {
        // Graduate the draft. If the job already has a REAL outline row
        // (the auto-extracted one), the model lands on THAT row - keeping
        // its plan-aligned points for the flat map, and leaving no sibling
        // rows to fight over which one the tab reads. Otherwise insert.
        const isUuid = (id: string) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        const real = outlines.data?.find((r) => isUuid(r.id));
        const saved = real
          ? await savePlanOutline({
              outlineId: real.id,
              projectId,
              plansetId: real.planset_id,
              pageNumber: real.page_number,
              points: real.points,
              pageAspect: real.page_aspect,
              features,
            })
          : await savePlanOutline({
              projectId,
              plansetId: plansPlanset.id,
              pageNumber: Math.max(1, outline.page_number),
              points: outline.points,
              pageAspect: outline.page_aspect,
              features,
            });
        discardLocalOutline(outline.planset_id, outline.page_number, outline.id);
        return saved;
      }
      // First outline on the job: a normalized main-mass footprint gives the
      // flat editor something sane to show.
      const foot = building.footprints[0] ?? [];
      const fxs = foot.map((p) => p.x);
      const fzs = foot.map((p) => p.z);
      const minX = Math.min(...fxs);
      const minZ = Math.min(...fzs);
      const span = Math.max(
        Math.max(...fxs) - minX,
        Math.max(...fzs) - minZ,
        1e-6,
      );
      const scale = 0.8 / span;
      return savePlanOutline({
        projectId,
        plansetId: plansPlanset.id,
        pageNumber: 1,
        points: foot.map((p) => ({
          x: 0.1 + (p.x - minX) * scale,
          y: 0.1 + (p.z - minZ) * scale,
        })),
        pageAspect: 1,
        features,
      });
    },
    onSuccess: () => {
      // A new trace can move stories — cohort keys follow.
      void syncProjectSignatures(projectId);
      queryClient.invalidateQueries({ queryKey: ["planOutlines", projectId] });
      toastSuccess("Model saved — Maps Interactive is using it now.");
      navigate(`/projects/${projectId}?tab=maps-interactive`);
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  const saveRef = useRef(save);
  saveRef.current = save;

  const openingsRef = useRef(openings.data);
  openingsRef.current = openings.data;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<ReturnType<typeof mountTracePlan> | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !job || viewRef.current || planImage.isLoading) return;
    viewRef.current = mountTracePlan(host, job, {
      toast: pushToast,
      planUrl: planImage.data?.url ?? null,
      // Auto-trace: the saved outline (auto-extracted from this same page)
      // as a starting polygon, converted to image pixels. Editable, undoable.
      outlineSeed:
        planImage.data && outline && outline.points.length >= 3
          ? [outline.points.map((pt) => ({
              x: pt.x * planImage.data!.w,
              y: pt.y * planImage.data!.h,
            }))]
          : null,
      // Seed dots from the extracted pins, scaled to the rendered image.
      dotSeed: (planImg: HTMLImageElement) => {
        const list = openingsRef.current ?? [];
        const w = planImg.naturalWidth;
        const h = planImg.naturalHeight;
        if (!w || !h || list.length === 0) return null;
        const byCode = new Map(
          list
            .filter((o) => o.pin_x != null && o.pin_y != null)
            .map((o) => [normalizeMarkCode(o.opening_code), o]),
        );
        const seed: Record<string, { x: number; y: number }> = {};
        for (const win of job.windows) {
          const o = byCode.get(normalizeMarkCode(String(win.id)));
          if (o) seed[String(win.id)] = { x: o.pin_x! * w, y: o.pin_y! * h };
        }
        return Object.keys(seed).length ? seed : null;
      },
      // Vision placement (wave V-A): suggested pins for THIS page only — a
      // suggestion normalized against a different sheet would land nowhere
      // near its real callout on this one. Confirmed (pin_x set) openings
      // are never suggested in the first place (the rescan law), but this
      // filter is what keeps the dashed dots honest about which sheet
      // they belong to as the picker above flips pages.
      suggestedSeed: (planImg: HTMLImageElement) => {
        const list = openingsRef.current ?? [];
        const w = planImg.naturalWidth || planImage.data?.w || 0;
        const h = planImg.naturalHeight || planImage.data?.h || 0;
        if (!w || !h) return null;
        const seed: Record<string, { x: number; y: number; confidence: number }> = {};
        for (const o of list) {
          if (o.suggested_pin_x == null || o.suggested_pin_y == null) continue;
          if (o.suggested_page_number != null && o.suggested_page_number !== underlayPage) {
            continue;
          }
          const px = normalizedToPixel({ x: o.suggested_pin_x, y: o.suggested_pin_y }, w, h);
          seed[o.opening_code] = { x: px.x, y: px.y, confidence: o.suggested_confidence ?? 0.5 };
        }
        return Object.keys(seed).length ? seed : null;
      },
      // A suggestion becomes a real pin the instant it is confirmed —
      // "the tracer already writes them" (ProjectMap's placePin, same
      // pin_x/pin_y/page_number columns) — independent of whether this
      // trace is ever Submitted. Fire-and-forget from the renderer's own
      // point of view; failures surface as a toast, same as everywhere else
      // an update can be refused by the database.
      confirmSuggestion: (id: string, pos: { x: number; y: number }) => {
        const openingId = openingIdForMark(openingsRef.current ?? [], id);
        if (!openingId) return;
        const norm = pixelToNormalized(
          pos,
          planImage.data?.w ?? 0,
          planImage.data?.h ?? 0,
        );
        void updateOpening(openingId, {
          pin_x: norm.x,
          pin_y: norm.y,
          page_number: underlayPage,
          suggested_pin_x: null,
          suggested_pin_y: null,
          suggested_page_number: null,
          suggested_at: null,
          suggested_confidence: null,
        })
          .then(() => queryClient.invalidateQueries({ queryKey: ["openings", projectId] }))
          .catch((e) => pushToast(formatApiError(e), "error"));
      },
      // Dismiss clears the suggestion only — pin_x/pin_y stay null, so the
      // rescan law leaves this mark free to be suggested again later.
      dismissSuggestion: (id: string) => {
        const openingId = openingIdForMark(openingsRef.current ?? [], id);
        if (!openingId) return;
        void updateOpening(openingId, {
          suggested_pin_x: null,
          suggested_pin_y: null,
          suggested_page_number: null,
          suggested_at: null,
          suggested_confidence: null,
        })
          .then(() => queryClient.invalidateQueries({ queryKey: ["openings", projectId] }))
          .catch((e) => pushToast(formatApiError(e), "error"));
      },
      // Phase 2: what the sheet titles said. Auto-place uses it to create
      // the detected stories and land each dot on its own story; windows on
      // pages the titles couldn't resolve stay in the tray — the Unclear
      // queue, resolved by a human drag.
      storyPlan: () => {
        const det = planImage.data?.detection;
        if (!det || det.stories.length < 2) return null;
        const pageToStory = new Map(det.pages.map((pg) => [pg.pageNumber, pg]));
        const byId: Record<
          string,
          { story: number; evidence: string; confidence?: "probable" | "confirmed"; range?: [number, number] }
        > = {};
        const unclear: Record<string, string> = {};
        const list = openingsRef.current ?? [];
        const byCode = new Map(list.map((o) => [normalizeMarkCode(o.opening_code), o]));
        // Phase 3: floor-encoded marks ("W-201") are a second, independent
        // signal — but only after they validate against the titles with zero
        // contradictions (many sets number by type, not floor).
        const prefixCheck = validateMarkPrefixes(
          list.map((o) => ({
            code: o.opening_code,
            titleStory: pageToStory.get(o.page_number)?.range
              ? undefined
              : pageToStory.get(o.page_number)?.story,
          })),
        );
        for (const win of job.windows) {
          const o = byCode.get(normalizeMarkCode(String(win.id)));
          if (!o) continue;
          const pg = pageToStory.get(o.page_number);
          if (pg?.story) {
            const entry: (typeof byId)[string] = {
              story: pg.story,
              evidence: `sheet ${o.page_number}: ${pg.evidence}`,
              confidence: "probable",
            };
            if (pg.range) entry.range = pg.range;
            const pre = markPrefixStory(o.opening_code);
            if (prefixCheck.trusted && pre != null && pre === pg.story && !pg.range) {
              // Two independent signals agree: that is what confirmed means.
              entry.confidence = "confirmed";
              entry.evidence += ` + mark prefix ${o.opening_code}`;
            }
            byId[String(win.id)] = entry;
          } else {
            const un = det.unresolved.find((u) => u.pageNumber === o.page_number);
            unclear[String(win.id)] = un
              ? `${un.reason} (${un.evidence})`
              : `sheet ${o.page_number} gives no story`;
          }
        }
        return { stories: det.stories, byId, unclear };
      },
      pushOp: (op: { op: string; building?: AuthoredModel["building"]; window?: { id: string } }) => {
        if (op.op === "building" && op.building) staged.current.building = op.building;
        if (op.op === "upsert" && op.window) {
          staged.current.upserts.set(String(op.window.id), op.window);
        }
      },
      done: () => saveRef.current.mutate(),
      scaleSuggestion: planImage.data?.scaleSuggestion ?? null,
      // Wave N: whatever north this outline already carries, so re-opening
      // the tracer restores the arrow instead of forgetting it. Read from
      // the OUTLINE, not the authored model's building — the tracer's own
      // Submit is what puts it there in the first place (see the northDeg
      // line in traceRenderer.ts's submit handler).
      northDeg: fitviewNorth(outline?.features) ?? null,
    });
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, planImage.data, planImage.isLoading]);

  /**
   * "Find placements" (V2): read the building planset's floor-plan pages for
   * every still-unplaced mark, write the results as SUGGESTED pins (never
   * real ones — readPlacementsFromDoc/apply_placement_suggestions), then pull
   * them into whatever trace is already open without losing unsaved work.
   * Re-runnable: a rerun only ever replaces a mark's suggestion while that
   * mark has no real pin yet (the rescan law) — a foreman working through
   * the review tray is never fighting the next click of this button.
   */
  const findPlacements = async () => {
    if (!buildingPlanset || placementRun.status === "reading") return;
    setPlacementRun({ status: "reading", pages: [], message: null, kind: null });
    try {
      const bytes = await downloadPlanset(buildingPlanset);
      const doc = await loadPdf(bytes);
      const result = await readPlacementsFromDoc(doc, openings.data ?? [], (pages) =>
        setPlacementRun((prev) => ({ ...prev, pages })),
      );

      if (result.limited) {
        setPlacementRun({
          status: "done",
          pages: result.floorPlanPages,
          message: result.note ?? null,
          kind: "error",
        });
        if (result.note) pushToast(result.note, "error");
        return;
      }

      const { saved: appliedCount, unavailable } = await applyPlacementSuggestions(
        projectId,
        result.suggestions.map((s) => ({
          openingId: s.openingId,
          x: s.x,
          y: s.y,
          page: s.page,
          confidence: s.confidence,
        })),
      );

      await queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
      // invalidateQueries resolves once the refetch lands in the CACHE, but
      // this component's own re-render (and openingsRef's refresh with it)
      // is scheduled separately — reading the cache directly is what
      // guarantees refreshSuggestions sees the fresh suggested_pin_x rows
      // rather than whatever render happened to run last.
      const fresh = queryClient.getQueryData<typeof openings.data>([
        "openings",
        projectId,
      ]);
      if (fresh) openingsRef.current = fresh;
      viewRef.current?.refreshSuggestions();

      // suggested/saved are kept as two separate numbers on purpose (the Mad
      // Moose bug): extract-placement can match every known mark while
      // apply_placement_suggestions saves fewer of them — or none — because
      // the rescan law skips a mark that already has a real pin, or because
      // the RPC isn't live yet on this database (isMissingPlacementFunction's
      // degrade guard — see its comment in install/api.ts). Collapsing both
      // into one "placed" count is exactly what let a zero-write read as
      // 10-for-10 success; placementResultSummary/placementToastKind never
      // let that happen, and `unavailable` keeps the write-path failure from
      // being mislabeled "already placed" — the opposite of what a foreman
      // should do next.
      const message = placementResultSummary({
        suggested: result.suggestions.length,
        saved: appliedCount,
        notFound: result.notFoundMarks.length,
        unknown: result.unknownCallouts.length,
        unavailable,
      });
      const kind = placementToastKind({
        suggested: result.suggestions.length,
        saved: appliedCount,
      });
      setPlacementRun({ status: "done", pages: result.floorPlanPages, message, kind });
      if (kind === "error") {
        pushToast(message, "error");
      } else {
        toastSuccess(message);
      }
    } catch (e) {
      setPlacementRun({ status: "done", pages: [], message: null, kind: null });
      pushToast(formatApiError(e), "error");
    }
  };

  if (projects.isLoading || openings.isLoading || outlines.isLoading) {
    return <div className="page"><p className="muted">Loading the tracer…</p></div>;
  }
  if (!project) {
    return <div className="page"><p className="error">Job not found.</p></div>;
  }

  return (
    <div className="page">
      <header className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <BackChip fallback={`/projects/${projectId}?tab=maps-interactive`} label="Back to Maps Interactive" />
          <h1>Trace 3D model</h1>
        </div>
        {save.isPending && <span className="muted">Saving…</span>}
      </header>
      {/* Sheet picker: toggle spec sheet ⇄ plan-set and flip to the page
          for the floor being traced. Underlay only — the trace itself is
          image-independent (re-registered by dot↔pin matching). */}
      {(plansets.data?.length ?? 0) > 0 && (
        <div className="row-gap" style={{ alignItems: "center", marginBottom: 6 }}>
          <select
            aria-label="Sheet set"
            value={plansPlanset?.id ?? ""}
            onChange={(e) => {
              setPickedPlansetId(e.target.value || null);
              setPickedPage(1);
            }}
          >
            {(plansets.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.kind === "specs" ? "Spec sheet" : "Plan-set"}
                {p.page_count ? ` · ${p.page_count} pages` : ""}
              </option>
            ))}
          </select>
          <button
            className="button-like studio-mini"
            aria-label="Previous page"
            disabled={underlayPage <= 1}
            onClick={() => setPickedPage(Math.max(1, underlayPage - 1))}
          >
            ◀
          </button>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            page {underlayPage}
            {plansPlanset?.page_count ? ` / ${plansPlanset.page_count}` : ""}
          </span>
          <button
            className="button-like studio-mini"
            aria-label="Next page"
            disabled={
              plansPlanset?.page_count != null && underlayPage >= plansPlanset.page_count
            }
            onClick={() => setPickedPage(underlayPage + 1)}
          >
            ▶
          </button>
        </div>
      )}
      {/* Vision placement (wave V-A), triggered on purpose — never automatic,
          so the AI spend stays a deliberate tap. Reads the building plan-set's
          floor-plan pages for every still-unplaced mark and drops suggested
          (dashed) dots into the tracer above for review. */}
      {buildingPlanset && (
        <div className="row-gap" style={{ alignItems: "center", marginBottom: 6 }}>
          <button
            className="button-like studio-mini"
            onClick={() => void findPlacements()}
            disabled={placementRun.status === "reading"}
          >
            {placementRun.status === "reading" ? "Reading the plan…" : "Find placements"}
          </button>
          {placementRun.status === "reading" && placementRun.pages.length > 0 && (
            <span className="muted">
              Reading page{placementRun.pages.length === 1 ? "" : "s"}{" "}
              {placementRun.pages.join(", ")}…
            </span>
          )}
          {placementRun.status === "done" && placementRun.message && (
            <span className={placementRun.kind === "error" ? "error" : "muted"}>
              {placementRun.message}
            </span>
          )}
        </div>
      )}
      <div className="fitview-app fittrace-app" ref={hostRef} />
    </div>
  );
}
