import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  assignOpeningsInOrder,
  getMyProfile,
  listMarkSpecs,
  listOpenings,
  listPlanOutlines,
  listProfiles,
} from "../../lib/install/api";
import type { Project } from "../../lib/types";
import { pushToast } from "../../lib/toast";
import { useT } from "../../lib/i18n";
import { formatApiError } from "../../lib/install/errors";
import { listQcPassedOpeningIds } from "../../lib/ops";
import { listOpeningPhases } from "../../lib/install/phases";
import { isForemanPlus, isSupervisorPlus } from "../../lib/install/types";
import { dataOffIds } from "../../lib/install/dataOff";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import {
  buildAuthoredJob,
  buildFitViewJob,
  fitviewCalibration,
  fitviewModel,
  fitviewNorth,
  normalizeMarkCode,
  preferModelOutline,
  unplacedScheduleMarks,
} from "../../lib/fitview/adapter";
import { mountFitView } from "../../lib/fitview/fitviewRenderer";
import { jobModelFromFeatures } from "../../lib/modelstudio/projects";
import { listScheduledMarks } from "../../lib/warehouse/warehouseCards";
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
  // Merged tab (owner call, 2026-08-13): the model view is the showpiece,
  // Sheets is the old 2D plan map (pins, dispatch, planset pages) — one tab,
  // two views. ?mapview=sheets (the ?tab=map redirect) forces Sheets for
  // deep links.
  const [searchParams] = useSearchParams();
  // Flat is the ONLY model view now (owner decision, 2026-08-21): the old
  // "3D (beta)" toggle is cut — it was the iOS crash class flat replaced as
  // the default on 2026-08-19, and a beta nobody could turn back off wasn't
  // worth keeping around. A device that had earlier stored "3d" is
  // sanitized back to flat below, on read, so it can never silently reopen
  // a view that no longer exists.
  const [mapView, setMapViewState] = useState<"flat" | "sheets">(() => {
    if (searchParams.get("mapview") === "sheets") return "sheets";
    try {
      const stored = localStorage.getItem("infinity.mapsView");
      if (stored === "3d") {
        // Overwrite too, not just sanitize-on-read — otherwise this same
        // dead value keeps surfacing on every future load.
        localStorage.setItem("infinity.mapsView", "flat");
        return "flat";
      }
      return stored === "sheets" ? "sheets" : "flat";
    } catch {
      return "flat";
    }
  });
  const setMapView = (v: "flat" | "sheets") => {
    setMapViewState(v);
    try {
      localStorage.setItem("infinity.mapsView", v);
    } catch {
      /* in-memory only */
    }
  };
  const { effectiveRole } = useEffectiveRole();
  const t = useT();
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
  // Crew roster for the map's Assign mode (foreman+): pick windows on the
  // model, pick a person, done — the Dispatch tab lists it as always.
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const qcPassed = useQuery({
    queryKey: ["qcPassed", projectId],
    queryFn: () => listQcPassedOpeningIds(projectId),
  });
  const phases = useQuery({
    queryKey: ["openingPhases", projectId],
    queryFn: () => listOpeningPhases(projectId),
  });
  // B3 (wave V-B): the job's schedule of marks — SAME rows and SAME query
  // key ModelStudio.tsx already fetches, so a visit to either tab warms the
  // other's cache. This is the "what should exist" side of the unplaced
  // count below; job.windows (built below) is the "what's actually on the
  // model" side.
  const scheduledMarks = useQuery({
    queryKey: ["scheduledMarks", [projectId]],
    queryFn: () => listScheduledMarks([projectId]),
  });

  // The model-bearing outline wins; the auto-extracted one is a fallback.
  const outline = preferModelOutline(outlines.data);
  // Whether a supervisor has saved a Studio (3D builder) model for this job
  // — gates the "Walk the 3D model" door to the phone-friendly viewer
  // (Studio 100x #27). A DIFFERENT thing from the fitview outline model
  // above: this is features.modelstudio, not features.fitview.model.
  const hasStudioModel = Boolean(jobModelFromFeatures(outline?.features));

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
      // Wave E: amber for a unit whose record is wrong. Read straight off the
      // openings this view already has — no extra query, and it stays amber
      // after the install and after QC, until a foreman clears the flag.
      dataOffOpeningIds: dataOffIds(openings.data ?? []),
    };
    // A full hand-traced survey model (multi-mass footprint, named walls,
    // surveyor-placed windows) beats anything derivable from plan pins —
    // when the outline carries one, use it and only merge live status in.
    const authored = fitviewModel(outline.features);
    // Wave G: specs are already fetched above for the pin-derived path below
    // (buildFitViewJob) — threading them here too gets pane_grid onto the
    // authored path's windows, so a mark's real CAD cell draws the same way
    // whether or not this job has a hand-traced/authored model.
    if (authored) return buildAuthoredJob(authored, meta, openings.data, view, specs.data);
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

  // B3 (wave V-B, the Mad Moose story): schedule marks with nothing placed
  // for them on THIS rendered model — never pinned, or pinned on a
  // different sheet. Computed here, outside the vendored renderer, then
  // carried on the job object it already understands (unplacedMarks).
  const unplaced = useMemo(
    () =>
      job
        ? unplacedScheduleMarks(
            (scheduledMarks.data ?? []).map((m) => m.mark_code),
            job.windows.map((w) => w.id),
          )
        : [],
    [job, scheduledMarks.data],
  );
  const jobForRenderer = useMemo(
    () => (job ? { ...job, unplacedMarks: unplaced } : null),
    [job, unplaced],
  );

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
  const profilesRef = useRef(profiles.data);
  profilesRef.current = profiles.data;
  const queryClient = useQueryClient();
  // Which role the live renderer was built for. The Assign button exists only
  // if `onAssign` was in the shim AT MOUNT — the renderer reads it once and
  // unhides the button, and nothing re-reads it later. So a supervisor whose
  // profile lands AFTER the job does used to get a map with no Assign button,
  // permanently, until they left the tab and came back. Nothing made that
  // visible until the warehouse pre-load started running at sign-in (D9) and
  // reliably won the race the profile fetch used to win.
  const builtForRole = useRef<string | null | undefined>(null);
  // Used to guard against rebuilding for the same view a live host was
  // already built for. No real transition exercises the "different view,
  // same live host" branch now that flat is the only model view (that used
  // to be flat<->3D), but the check is still correct — always true, once a
  // host is live — so it stays rather than being one more thing to re-prove
  // safe to touch.
  const builtForView = useRef<string | null>(null);
  // A renderer crash used to bubble all the way to the app-wide error
  // boundary (main.tsx) and white-screen the whole page over a single bad
  // map. Caught locally instead (owner decision, 2026-08-21) so only the map
  // area goes dark, with a way back in that doesn't need a reload.
  const [mountFailed, setMountFailed] = useState(false);
  // Wave Y (Y3): the unit the foreman tapped "Record install for…" on, held
  // while they pick a person. The renderer hands over the window it drew, so
  // the mark code is all React needs to find the real opening.
  const [recordFor, setRecordFor] = useState<{ code: string; label: string } | null>(
    null,
  );
  const [retryNonce, setRetryNonce] = useState(0);
  const retryMount = () => {
    setMountFailed(false);
    setRetryNonce((n) => n + 1);
  };

  // Mount once, refresh in place on data changes — refresh keeps the camera
  // where the user left it, a remount would snap it back to the default.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !jobForRenderer) return;
    try {
      if (viewRef.current) {
        if (host.childElementCount > 0 && builtForRole.current === effectiveRole && builtForView.current === mapView) {
          // Same live host, same role — refresh in place, keep the camera.
          viewRef.current.refresh(jobForRenderer);
          return;
        }
        // Two ways to land here. The Sheets toggle unmounted the old host, so
        // the renderer is stranded on a detached node (black 3D view — owner
        // report, 2026-08-13). Or the role finally arrived and the live map was
        // built for a different one, which is the only way to get the Assign
        // button back. Either way: tear it down and mount fresh.
        viewRef.current.destroy();
        viewRef.current = null;
      }
      builtForRole.current = effectiveRole;
      builtForView.current = mapView;
      viewRef.current = mountFitView(host, jobForRenderer, {
        toast: pushToast,
        flatView: mapView === "flat",
        // Wave N: the mini-map's compass rose rotation, read once at mount —
        // same mount-time-only contract as `crew`/`onAssign` below. Display
        // only; the tracer (traceRenderer.ts) is the one place that sets it.
        northDeg: fitviewNorth(outline?.features) ?? null,
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
        // Assign mode (owner, 2026-08-14: "click on an installer, then multi
        // select windows... while i'm on the map interactive"): foreman+
        // only. Picks arrive as mark codes in tap order; they append to the
        // installer's existing sequence, same as the Sheets view.
        ...(isForemanPlus(effectiveRole)
          ? {
              crew: (profilesRef.current ?? [])
                .filter((p) => p.active)
                .map((p) => ({
                  id: p.id,
                  name: p.display_name ?? p.id.slice(0, 8),
                  role: p.role,
                })),
              // Wave Y (Y3). Foreman+ only, because the shim only carries it
              // for foreman+ — the renderer draws the button if and only if
              // the callback is there. It picks a PERSON and then opens the
              // real opening sheet: nothing is marked done from the map, and
              // the after photo, the grade and the flashing gate all still
              // apply (owner-approved refusal).
              onRecordFor: (win: { id: string; type?: string }) => {
                setRecordFor({ code: win.id, label: win.type ?? win.id });
              },
              // The renderer is a vanilla port with no t() of its own, so the
              // host hands it the two wave-Y button labels already translated.
              // Read once at mount, like `crew`, `onAssign` and `northDeg`
              // above: switching language on this tab relabels them the next
              // time the map is built, not mid-scene.
              labels: {
                recordFor: t("credit.recordFor"),
                assignOne: t("credit.assignOne"),
              },
              onAssign: (codes: string[], profileId: string | null) => {
                const all = openingsRef.current ?? [];
                const ids = codes
                  .map((c) => {
                    const want = normalizeMarkCode(c);
                    return all.find((o) => normalizeMarkCode(o.opening_code) === want)?.id;
                  })
                  .filter((id): id is string => Boolean(id));
                if (ids.length === 0) {
                  pushToast("Those units have no openings yet.", "error");
                  return;
                }
                void (async () => {
                  try {
                    await assignOpeningsInOrder(all, ids, profileId);
                    await queryClient.invalidateQueries({
                      queryKey: ["openings", projectId],
                    });
                    pushToast(
                      profileId
                        ? `${ids.length} unit${ids.length === 1 ? "" : "s"} assigned.`
                        : `${ids.length} unit${ids.length === 1 ? "" : "s"} unassigned.`,
                    );
                  } catch (e) {
                    pushToast(formatApiError(e), "error");
                  }
                })();
              },
            }
          : {}),
      });
      setMountFailed(false);
    } catch (e) {
      console.error("Maps Interactive failed to mount", e);
      viewRef.current = null;
      setMountFailed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobForRenderer, mapView, effectiveRole, retryNonce]);

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
        className={mapView === "flat" ? "button-like active-pill" : "button-like"}
        aria-pressed={mapView === "flat"}
        onClick={() => setMapView("flat")}
      >
        Map
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
        {hasStudioModel && (
          <Link
            className="button-like"
            style={{ marginBottom: 8 }}
            to={`/projects/${projectId}/model`}
          >
            Walk the 3D model
          </Link>
        )}
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
      <div style={fullscreen ? { display: "none" } : undefined}>
        {viewToggle}
        {hasStudioModel && (
          <Link
            className="button-like"
            style={{ marginBottom: 8 }}
            to={`/projects/${projectId}/model`}
          >
            Walk the 3D model
          </Link>
        )}
      </div>
      <div className={fullscreen ? "fitview-shell fitview-fullscreen" : "fitview-shell"}>
        <div className="fitview-toolbar">
          {!mountFailed && job && job.windows.length === 0 && (
            <p className="muted" style={{ margin: 0, flex: 1 }}>
              The outline is traced, but no openings are pinned on sheet{" "}
              {outline.page_number} yet — the model will populate as pins land.
            </p>
          )}
          {/* B3 (wave V-B): the partial case the zero-case banner above
              misses — some marks placed, others still off the model
              entirely (the Mad Moose job read as complete at "8/8 fitted"
              while its other marks were never pinned at all). */}
          {!mountFailed && job && job.windows.length > 0 && unplaced.length > 0 && (
            <p className="muted" style={{ margin: 0, flex: 1 }}>
              {unplaced.length} mark{unplaced.length === 1 ? "" : "s"} not yet
              placed
              {canEditModel && !fullscreen && (
                <>
                  {" → "}
                  <Link to={`/projects/${projectId}/trace-model`}>place them</Link>
                </>
              )}
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
        {/* Scoped failure (owner decision, 2026-08-21): in place of the map
            only, never the whole page. The host div below stays mounted
            (just hidden) so its ref is still valid when the retry re-runs
            the mount effect. */}
        {mountFailed && (
          <div className="empty-state" role="alert">
            <p className="muted">The map couldn&rsquo;t load.</p>
            <button type="button" className="button-like" onClick={retryMount}>
              Tap to try again
            </button>
          </div>
        )}
        <div
          className="fitview-app"
          ref={hostRef}
          style={mountFailed ? { display: "none" } : undefined}
        />
        {/* Wave Y (Y3): pick who installed it, then go to that window's own
            sheet with the person already chosen. The same crew list the assign
            sheet draws, so there is one roster on this screen and not two. */}
        {recordFor && (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <div className="modal-card">
              <span className="field-label">{t("credit.pickPerson")}</span>
              <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12.5 }}>
                {recordFor.label} · {t("credit.gateStillApplies")}
              </p>
              <div className="row-gap" style={{ flexWrap: "wrap" }}>
                {(profilesRef.current ?? [])
                  .filter((p) => p.active)
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="button-like"
                      data-record-for={p.id}
                      onClick={() => {
                        const want = normalizeMarkCode(recordFor.code);
                        const match = openingsRef.current?.find(
                          (o) => normalizeMarkCode(o.opening_code) === want,
                        );
                        setRecordFor(null);
                        if (!match) {
                          pushToast("That unit has no opening yet.", "error");
                          return;
                        }
                        navigate(
                          `/projects/${projectId}/opening/${match.id}?credit=${p.id}`,
                        );
                      }}
                    >
                      {p.display_name ?? p.id.slice(0, 8)}
                    </button>
                  ))}
              </div>
              <button
                type="button"
                className="button-like"
                style={{ marginTop: 10 }}
                onClick={() => setRecordFor(null)}
              >
                {t("credit.cancel")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
