import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  downloadPlanset,
  listMarkSpecs,
  listOpenings,
  listPlanOutlines,
  listPlansets,
  savePlanOutline,
} from "../../lib/install/api";
import { listProjects } from "../../lib/api";
import { loadPdf } from "../../lib/install/pdf";
import { renderPageJpeg } from "../../lib/install/renderSpecImages";
import { formatApiError } from "../../lib/install/errors";
import { pushToast, toastSuccess } from "../../lib/toast";
import {
  buildAuthoredJob,
  buildFitViewJob,
  fitviewCalibration,
  fitviewModel,
  normalizeMarkCode,
  type AuthoredModel,
} from "../../lib/fitview/adapter";
import { mountTracePlan } from "../../lib/fitview/traceRenderer";
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

  const outline = outlines.data?.[0] ?? null;
  const plansPlanset = useMemo(() => {
    const all = plansets.data ?? [];
    return all.find((p) => p.kind === "building") ?? all[0] ?? null;
  }, [plansets.data]);

  // The plan sheet as an image, rendered from the same planset the pins
  // live on. Big and async, so it gets its own query with a stable key.
  const planImage = useQuery({
    queryKey: ["tracePlanImage", plansPlanset?.id, outline?.page_number ?? 1],
    enabled: !!plansPlanset,
    staleTime: Infinity,
    queryFn: async () => {
      const bytes = await downloadPlanset(plansPlanset!);
      const doc = await loadPdf(bytes);
      const page = Math.min(outline?.page_number ?? 1, doc.numPages);
      return renderPageJpeg(doc, Math.max(1, page));
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
    if (authored) return buildAuthoredJob(authored, meta, openings.data);
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
  }, [project, outline, openings.data, specs.data, projectId]);

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

      const prevFeatures =
        outline && typeof outline.features === "object" && outline.features
          ? (outline.features as Record<string, unknown>)
          : {};
      const features = {
        ...prevFeatures,
        fitview: {
          longSideM,
          wallHeightM: building.height,
          source: "in-app trace",
          model: { building, windows: [...byId.values()] },
        },
      };

      if (outline) {
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
      planUrl: planImage.data ?? null,
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
      pushOp: (op: { op: string; building?: AuthoredModel["building"]; window?: { id: string } }) => {
        if (op.op === "building" && op.building) staged.current.building = op.building;
        if (op.op === "upsert" && op.window) {
          staged.current.upserts.set(String(op.window.id), op.window);
        }
      },
      done: () => saveRef.current.mutate(),
    });
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, planImage.data, planImage.isLoading]);

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
          <Link
            to={`/projects/${projectId}?tab=maps-interactive`}
            className="back-chip"
            aria-label="Back to Maps Interactive"
          >
            ‹
          </Link>
          <h1>Trace 3D model</h1>
        </div>
        {save.isPending && <span className="muted">Saving…</span>}
      </header>
      <div className="fitview-app fittrace-app" ref={hostRef} />
    </div>
  );
}
