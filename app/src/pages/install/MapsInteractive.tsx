import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  getMyProfile,
  listMarkSpecs,
  listOpenings,
  listPlanOutlines,
} from "../../lib/install/api";
import type { Project } from "../../lib/types";
import { pushToast } from "../../lib/toast";
import { listQcPassedOpeningIds } from "../../lib/ops";
import { listOpeningPhases } from "../../lib/install/phases";
import { isForemanPlus, isSupervisorPlus } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import {
  buildAuthoredJob,
  buildFitViewJob,
  fitviewCalibration,
  fitviewModel,
  normalizeMarkCode,
  preferModelOutline,
} from "../../lib/fitview/adapter";
import { mountFitView } from "../../lib/fitview/fitviewRenderer";
import { ProjectMap } from "./ProjectMap";
import "../../lib/fitview/fitview.css";

/**
 * The "Maps Interactive" project tab: the ported window-viewer 3D fit view,
 * fed live from this project's plan outline + opening pins + mark specs. The
 * renderer is vendored vanilla JS (see fitviewRenderer.ts) mounted into a div;
 * React owns data fetching and navigation, the renderer owns everything inside
 * its root. Tapping "Open opening" in the detail sheet deep-links to the
 * normal opening sheet, so install work stays on the one install path.
 */
export function MapsInteractive({ project }: { project: Project }) {
  const projectId = project.id;
  const navigate = useNavigate();
  // Merged tab (owner call, 2026-08-13): 3D is the showpiece, Sheets is the
  // old 2D plan map (pins, dispatch, planset pages) — one tab, two views.
  // First open lands on 3D; after that the tab remembers the last view.
  // ?mapview=sheets (the ?tab=map redirect) forces Sheets for deep links.
  const [searchParams] = useSearchParams();
  const [mapView, setMapViewState] = useState<"3d" | "sheets">(() => {
    if (searchParams.get("mapview") === "sheets") return "sheets";
    try {
      return localStorage.getItem("infinity.mapsView") === "sheets" ? "sheets" : "3d";
    } catch {
      return "3d";
    }
  });
  const setMapView = (v: "3d" | "sheets") => {
    setMapViewState(v);
    try {
      localStorage.setItem("infinity.mapsView", v);
    } catch {
      /* in-memory only */
    }
  };
  const { effectiveRole } = useEffectiveRole();
  // Editing the model is supervisor+ (stories design doc); the tab itself
  // is everyone's reference.
  const canEditModel = isSupervisorPlus(effectiveRole);

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
  const myProfile = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const qcPassed = useQuery({
    queryKey: ["qcPassed", projectId],
    queryFn: () => listQcPassedOpeningIds(projectId),
  });
  const phases = useQuery({
    queryKey: ["openingPhases", projectId],
    queryFn: () => listOpeningPhases(projectId),
  });

  // The model-bearing outline wins; the auto-extracted one is a fallback.
  const outline = preferModelOutline(outlines.data);

  const job = useMemo(() => {
    if (!outline || !openings.data) return null;
    const meta = {
      projectId,
      projectName: project.name,
      projectAddress: project.address,
    };
    // Who's looking decides what glows (adapter glowFor): installers see
    // their own red/yellow, foreman+ see everyone's, QC green is universal.
    // The same context re-spells mark ids in the work-order dialect
    // ("1A" -> "1-1") so the model matches what the crew is assigned.
    const view = {
      viewerId: myProfile.data?.id ?? null,
      managerView: isForemanPlus(effectiveRole),
      qcPassedOpeningIds: new Set(qcPassed.data ?? []),
      // Aqua frames: submitted flashing = solid, still-owed = dashed.
      flashedOpeningIds: new Set(
        (phases.data ?? [])
          .filter((p) => p.kind === "flashing" && p.status === "submitted")
          .map((p) => p.opening_id),
      ),
    };
    // A full hand-traced survey model (multi-mass footprint, named walls,
    // surveyor-placed windows) beats anything derivable from plan pins —
    // when the outline carries one, use it and only merge live status in.
    const authored = fitviewModel(outline.features);
    if (authored) return buildAuthoredJob(authored, meta, openings.data, view);
    return buildFitViewJob(
      {
        ...meta,
        outline: {
          points: outline.points,
          pageAspect: outline.page_aspect,
          pageNumber: outline.page_number,
        },
        openings: openings.data,
        specs: specs.data ?? [],
        // A seeded/surveyed outline can carry real-world calibration; without
        // it the adapter's documented defaults apply.
        ...fitviewCalibration(outline.features),
      },
      view,
    );
  }, [
    outline,
    openings.data,
    specs.data,
    projectId,
    project.name,
    project.address,
    myProfile.data?.id,
    effectiveRole,
    qcPassed.data,
    phases.data,
  ]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<ReturnType<typeof mountFitView> | null>(null);
  const navTimerRef = useRef<number | null>(null);

  // Full-screen is a CSS overlay, not the Fullscreen API: iOS home-screen
  // PWAs don't grant the API, and an inset-0 overlay behaves identically
  // everywhere. The renderer refits itself off the resize event.
  const [fullscreen, setFullscreen] = useState(false);
  const toggleFullscreen = (next: boolean) => {
    setFullscreen(next);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") toggleFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Latest openings for the tap-through lookup without remounting on refetch.
  const openingsRef = useRef(openings.data);
  openingsRef.current = openings.data;

  // Mount once, refresh in place on data changes — refresh keeps the camera
  // where the user left it, a remount would snap it back to the default.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !job) return;
    if (viewRef.current) {
      if (host.childElementCount > 0) {
        // Same live host — refresh in place, keep the camera.
        viewRef.current.refresh(job);
        return;
      }
      // The Sheets toggle unmounted the old host: the renderer is stranded
      // on a detached node (black 3D view — owner report, 2026-08-13).
      // Tear it down and mount fresh into the new div.
      viewRef.current.destroy();
      viewRef.current = null;
    }
    viewRef.current = mountFitView(host, job, {
      toast: pushToast,
      openOpening: (code: string) => {
        // Codes come in two dialects (survey "13A" vs extraction "13-1");
        // normalize both sides so the deep link finds its opening.
        const want = normalizeMarkCode(code);
        const match = openingsRef.current?.find(
          (o) => normalizeMarkCode(o.opening_code) === want,
        );
        if (!match) return;
        // Navigate only after the click dispatch has fully finished. React 19
        // re-renders discrete events synchronously, so navigating mid-click
        // swaps this DOM for the opening sheet and the tail of the SAME click
        // lands on its back-to-map link — bouncing the user straight past the
        // page they asked for. Deferring one tick makes the tap stick. The
        // timer is tracked so unmounting can cancel it — a navigation firing
        // after this tab is gone yanks the user off whatever page they're on.
        navTimerRef.current = window.setTimeout(() => {
          navTimerRef.current = null;
          navigate(`/projects/${projectId}/opening/${match.id}`);
        }, 0);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, mapView]);

  // Unmount-only teardown: the renderer owns global listeners until then,
  // and a still-pending deferred navigation must die with the tab.
  useEffect(
    () => () => {
      if (navTimerRef.current != null) clearTimeout(navTimerRef.current);
      navTimerRef.current = null;
      viewRef.current?.destroy();
      viewRef.current = null;
    },
    [],
  );

  const viewToggle = (
    <div className="seg" role="group" aria-label="Map view" style={{ marginBottom: 8 }}>
      <button
        className={mapView === "3d" ? "button-like active-pill" : "button-like"}
        aria-pressed={mapView === "3d"}
        onClick={() => setMapView("3d")}
      >
        3D
      </button>
      <button
        className={mapView === "sheets" ? "button-like active-pill" : "button-like"}
        aria-pressed={mapView === "sheets"}
        onClick={() => setMapView("sheets")}
      >
        Sheets
      </button>
    </div>
  );

  // The Sheets view IS the old 2D map — pins, dispatch, planset pages,
  // re-extract. Everything the 3D model is fed by gets fixed here.
  if (mapView === "sheets") {
    return (
      <div>
        {viewToggle}
        <ProjectMap embedded />
      </div>
    );
  }

  if (outlines.isLoading || openings.isLoading) {
    return (
      <div>
        {viewToggle}
        <p className="muted">Loading the model…</p>
      </div>
    );
  }

  if (!outline) {
    return (
      <div>
        {viewToggle}
        <div className="empty-state">
          <h3>No building model yet</h3>
          <p className="muted">
            The interactive map builds itself from this job's traced outline.
            Trace one from the floor plan (Sheets view) and it appears here
            automatically.
          </p>
          <button className="button-like" onClick={() => setMapView("sheets")}>
            Open Sheets to trace the outline
          </button>
        </div>
      </div>
    );
  }

  // One stable tree so the renderer's host node survives data transitions —
  // a branch swap here would strand the mounted view on a detached div.
  return (
    <div>
      <div style={fullscreen ? { display: "none" } : undefined}>{viewToggle}</div>
      <div className={fullscreen ? "fitview-shell fitview-fullscreen" : "fitview-shell"}>
      <div className="fitview-toolbar">
        {job && job.windows.length === 0 && (
          <p className="muted" style={{ margin: 0, flex: 1 }}>
            The outline is traced, but no openings are pinned on sheet{" "}
            {outline.page_number} yet — the model will populate as pins land.
          </p>
        )}
        {canEditModel && !fullscreen && (
          <Link
            className="button-like"
            style={{ marginLeft: "auto" }}
            to={`/projects/${projectId}/trace-model`}
          >
            Trace 3D model
          </Link>
        )}
        <button
          type="button"
          className="button-like"
          style={canEditModel && !fullscreen ? undefined : { marginLeft: "auto" }}
          aria-pressed={fullscreen}
          onClick={() => toggleFullscreen(!fullscreen)}
        >
          {fullscreen ? "Exit full screen" : "Full screen"}
        </button>
      </div>
        <div className="fitview-app" ref={hostRef} />
      </div>
    </div>
  );
}
