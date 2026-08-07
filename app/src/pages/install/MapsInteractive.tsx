import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listMarkSpecs, listOpenings, listPlanOutlines } from "../../lib/install/api";
import type { Project } from "../../lib/types";
import { pushToast } from "../../lib/toast";
import { isForemanPlus } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import {
  buildAuthoredJob,
  buildFitViewJob,
  fitviewCalibration,
  fitviewModel,
  normalizeMarkCode,
} from "../../lib/fitview/adapter";
import { mountFitView } from "../../lib/fitview/fitviewRenderer";
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
  const { effectiveRole } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);

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

  // First outline wins for v1: one traced sheet = one building model.
  const outline = outlines.data?.[0] ?? null;

  const job = useMemo(() => {
    if (!outline || !openings.data) return null;
    const meta = {
      projectId,
      projectName: project.name,
      projectAddress: project.address,
    };
    // A full hand-traced survey model (multi-mass footprint, named walls,
    // surveyor-placed windows) beats anything derivable from plan pins —
    // when the outline carries one, use it and only merge live status in.
    const authored = fitviewModel(outline.features);
    if (authored) return buildAuthoredJob(authored, meta, openings.data);
    return buildFitViewJob({
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
    });
  }, [outline, openings.data, specs.data, projectId, project.name, project.address]);

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
      viewRef.current.refresh(job);
      return;
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
  }, [job]);

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

  if (outlines.isLoading || openings.isLoading) {
    return <p className="muted">Loading the model…</p>;
  }

  if (!outline) {
    return (
      <div className="empty-state">
        <h3>No building model yet</h3>
        <p className="muted">
          The interactive map builds itself from this job's traced outline.
          Trace one from the floor plan and it appears here automatically.
        </p>
        <Link className="button-like" to={`/projects/${projectId}?tab=map`}>
          Open the plan map to trace the outline
        </Link>
      </div>
    );
  }

  // One stable tree so the renderer's host node survives data transitions —
  // a branch swap here would strand the mounted view on a detached div.
  return (
    <div className={fullscreen ? "fitview-shell fitview-fullscreen" : "fitview-shell"}>
      <div className="fitview-toolbar">
        {job && job.windows.length === 0 && (
          <p className="muted" style={{ margin: 0, flex: 1 }}>
            The outline is traced, but no openings are pinned on sheet{" "}
            {outline.page_number} yet — the model will populate as pins land.
          </p>
        )}
        {isLead && !fullscreen && (
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
          style={isLead && !fullscreen ? undefined : { marginLeft: "auto" }}
          aria-pressed={fullscreen}
          onClick={() => toggleFullscreen(!fullscreen)}
        >
          {fullscreen ? "Exit full screen" : "Full screen"}
        </button>
      </div>
      <div className="fitview-app" ref={hostRef} />
    </div>
  );
}
