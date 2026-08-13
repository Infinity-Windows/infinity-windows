// Model Studio (SPIKE, 2026-08-13): the approved blueprint3d-modern
// foundation embedded with real project data — traced walls seeded from the
// same fit-view job the 3D map renders, plus the first few pinned openings
// as draggable in-wall window items. Desktop-only by design (industry
// pattern: edit the 2D plan, the 3D builds itself); phones keep the viewer.
//
// Spike boundaries, on purpose: ground story only, N≤8 seeded windows, save
// round-trips into project_plan_outlines.features.modelstudio without
// touching the fitview model. Multi-story, opening-binding UX and HD
// materials are Phase 1 work once this foundation is judged on BLACK22.

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BackChip } from "../../components/BackChip";
import { pushToast } from "../../lib/toast";
import {
  listMarkSpecs,
  listOpenings,
  listPlanOutlines,
  savePlanOutline,
} from "../../lib/install/api";
import {
  buildAuthoredJob,
  buildFitViewJob,
  fitviewCalibration,
  fitviewModel,
  preferModelOutline,
} from "../../lib/fitview/adapter";
import { buildStudioSeed } from "../../lib/modelstudio/fromProject";
import {
  Blueprint3d,
  floorplannerModes,
} from "../../lib/modelstudio/core";

const WINDOW_MODEL = "/modelstudio/models/window.js";

export function ModelStudio({ projectId: propId }: { projectId?: string } = {}) {
  const { id: routeId = "" } = useParams();
  const projectId = propId ?? routeId;
  const embedded = Boolean(propId);
  const hostReady = useRef(false);
  const bpRef = useRef<Blueprint3d | null>(null);
  const [mode, setModeState] = useState<number>(0);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const outlines = useQuery({
    queryKey: ["planOutlines", projectId],
    queryFn: () => listPlanOutlines(projectId),
    enabled: Boolean(projectId),
  });
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
    enabled: Boolean(projectId),
  });
  const specs = useQuery({
    queryKey: ["markSpecs", projectId],
    queryFn: () => listMarkSpecs(projectId),
    enabled: Boolean(projectId),
  });

  const outline = useMemo(
    () => preferModelOutline(outlines.data ?? []),
    [outlines.data],
  );

  // The same job the 3D map renders — one source of truth for geometry.
  const job = useMemo(() => {
    if (!outline || !openings.data) return null;
    const meta = { projectId, projectName: "Model Studio", projectAddress: null };
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
      ...fitviewCalibration(outline.features),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outline, openings.data, specs.data, projectId]);

  const seed = useMemo(
    () => (job ? buildStudioSeed(job as never) : null),
    [job],
  );

  // Mount once when the seed and both host elements exist. The vendor core
  // owns everything inside its two containers from here.
  useEffect(() => {
    if (!seed || hostReady.current) return;
    const floorplanEl = document.getElementById("studio-floorplan");
    const threeEl = document.getElementById("studio-three");
    if (!floorplanEl || !threeEl) return;
    hostReady.current = true;

    const bp = new Blueprint3d({
      floorplannerElement: "studio-floorplan",
      threeElement: "#studio-three",
      textureDir: "/modelstudio/",
      enableWheelZoom: true,
      alwaysSpin: false,
    });
    bpRef.current = bp;

    // Saved Studio model wins; otherwise seed from the traced building.
    const saved = (outline?.features as { modelstudio?: { serialized?: string } } | null)
      ?.modelstudio?.serialized;
    bp.model.loadSerialized(saved ?? seed.serialized);

    if (!saved) {
      for (const w of seed.windows) {
        bp.model.scene.addItem(
          3,
          WINDOW_MODEL,
          { itemName: w.id, itemType: 3, modelUrl: WINDOW_MODEL },
          { x: w.x, y: w.elevation, z: w.y },
          w.rotation,
          undefined,
          false,
        );
      }
    }
    bp.floorplanner?.reset();
    bp.three.updateWindowSize();
    setStatus(
      saved
        ? "Loaded your saved Studio model."
        : `Seeded from the traced building — ${seed.windows.length} opening${seed.windows.length === 1 ? "" : "s"} placed.`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const setMode = (m: number) => {
    bpRef.current?.floorplanner?.setMode(m);
    setModeState(m);
  };

  const save = async () => {
    const bp = bpRef.current;
    if (!bp || !outline) return;
    setSaving(true);
    try {
      const serialized = bp.model.exportSerialized();
      const prev = (outline.features ?? {}) as Record<string, unknown>;
      await savePlanOutline({
        outlineId: outline.id,
        projectId,
        plansetId: outline.planset_id,
        pageNumber: outline.page_number,
        points: outline.points,
        pageAspect: outline.page_aspect,
        // Merge: the fitview model and 2D features must survive untouched.
        features: { ...prev, modelstudio: { serialized, savedAt: new Date().toISOString() } },
      });
      pushToast("Studio model saved.");
    } catch (e) {
      pushToast(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const narrow = typeof window !== "undefined" && window.innerWidth < 900;

  return (
    <div className={embedded ? "studio-page" : "page studio-page"}>
      {!embedded && (
        <header className="page-header">
          <div>
            <h1>Model Studio</h1>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Spike — edit the plan on the left, the 3D builds itself on the right.
            </p>
          </div>
          <BackChip fallback={`/projects/${projectId}?tab=maps-interactive`} label="Back" />
        </header>
      )}

      {narrow && (
        <p className="warn-text" style={{ fontSize: 12.5 }}>
          The Studio is built for a laptop screen — editing tools need the room.
        </p>
      )}

      <div className="row-gap" style={{ flexWrap: "wrap", marginBottom: 8 }}>
        <div className="seg" role="group" aria-label="Plan tool">
          <button
            className={mode === floorplannerModes.MOVE ? "button-like active-pill" : "button-like"}
            onClick={() => setMode(floorplannerModes.MOVE)}
          >
            Move
          </button>
          <button
            className={mode === floorplannerModes.DRAW ? "button-like active-pill" : "button-like"}
            onClick={() => setMode(floorplannerModes.DRAW)}
          >
            Draw walls
          </button>
          <button
            className={mode === floorplannerModes.DELETE ? "button-like active-pill" : "button-like"}
            onClick={() => setMode(floorplannerModes.DELETE)}
          >
            Delete
          </button>
        </div>
        <button
          className="button-like"
          onClick={() => {
            bpRef.current?.model.scene.addItem(
              3,
              WINDOW_MODEL,
              { itemName: "New window", itemType: 3, modelUrl: WINDOW_MODEL },
              undefined,
              undefined,
              undefined,
              false,
            );
            pushToast("Window added — drag it onto a wall in the 3D view.");
          }}
        >
          + Add window
        </button>
        <button
          className="button-like active-pill"
          style={{ marginLeft: "auto" }}
          disabled={saving || !outline}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save model"}
        </button>
      </div>
      {status && (
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 11.5 }}>{status}</p>
      )}

      {!outline && !outlines.isLoading && (
        <p className="muted">
          No traced building yet — trace one on the job's Maps Interactive tab
          (Sheets view) first, then come back.
        </p>
      )}

      <div className="studio-split">
        <div className="studio-pane">
          <p className="tcx-label" style={{ margin: "0 0 4px" }}>Plan (2D)</p>
          <canvas id="studio-floorplan" className="studio-canvas" />
        </div>
        <div className="studio-pane">
          <p className="tcx-label" style={{ margin: "0 0 4px" }}>Model (3D)</p>
          <div id="studio-three" className="studio-three" />
        </div>
      </div>
    </div>
  );
}
