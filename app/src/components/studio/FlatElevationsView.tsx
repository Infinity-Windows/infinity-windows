// The Studio's "Flat" view (owner ask, 2026-08-20): the current floor's
// walls unwrapped into a horizontal scroll row, read from the VENDOR MODEL
// exactly like the 2D plan and 3D scene are — through core.d.ts's shim
// only — so all three views can never drift out of sync; they're just
// three renderings of the same Blueprint3d. Layout math lives in
// lib/modelstudio/flatElevations.ts (pure, unit-tested); this file is the
// untested glue: reading the live model into that module's plain shapes on
// every render, and turning a drag back into a plan-space position.
//
// Tapping an item (no drag) hands off to ModelStudio's existing
// selectUnit — the SAME Selected-unit panel the 2D/3D views open, so
// editing behaves identically no matter which view you tapped from.
// Dragging an item commits through onCommitMove, which ModelStudio.tsx
// wires to the SAME pushUndo → position.set → placeInRoom → snapIfCorner →
// growWallToFit sequence every other move in that file already uses —
// nothing here invents a new way to place a unit, this view only computes
// WHERE (which wall + offset) a drop lands.

import { useEffect, useRef, useState } from "react";
import type { Blueprint3d, StudioItem, StudioWall } from "../../lib/modelstudio/core";
import {
  BUILDING_GAP_PX,
  dropTarget,
  flatLayout,
  wallWalkOrder,
  type DropTarget,
  type FlatCorner,
  type FlatLayoutItem,
  type FlatLayoutWallInput,
  type FlatWall,
  type WalkedWall,
} from "../../lib/modelstudio/flatElevations";
import { unitWidthMm, type UnitConfig } from "../../lib/modelstudio/units";

/** The tallest wall is fit to this fraction of the stage's height (owner
 * design: "one shared px-per-cm scale that fits the tallest wall ~60% of
 * the stage height"). */
const FIT_FRACTION = 0.6;
/** Only used for one frame before the stage container has a real size. */
const FALLBACK_SCALE_PX_PER_CM = 0.15;
/** Below this many px of pointer travel, a press-and-release reads as a
 * tap (select) rather than a drag (move) — matches selectUnit's own
 * "first tap selects" intent, just measured in screen pixels instead of a
 * hover/click distinction. */
const DRAG_THRESHOLD_PX = 4;

interface Gathered {
  wallInputs: FlatLayoutWallInput[];
  wallsById: Map<string, StudioWall>;
  walkedById: Map<string, WalkedWall>;
  itemsById: Map<string, StudioItem>;
  tallestHeightCm: number;
}

/** Read the current floor's walls + in-wall units off the live vendor
 * model into flatElevations.ts's plain shapes. The only vendor reads in
 * this file — every field here comes through core.d.ts's typed surface. */
function gatherFloor(bp: Blueprint3d): Gathered | null {
  const floorWalls = bp.model.floorplan.walls;
  if (floorWalls.length === 0) return null;

  const wallsById = new Map<string, StudioWall>();
  const wallIndexOf = new Map<StudioWall, string>();
  const cornerIdOf = new Map<unknown, string>();
  const corners: FlatCorner[] = [];
  const idForCorner = (c: { x: number; y: number }): string => {
    const existing = cornerIdOf.get(c);
    if (existing) return existing;
    const id = `c${cornerIdOf.size}`;
    cornerIdOf.set(c, id);
    corners.push({ id, x: c.x, y: c.y });
    return id;
  };

  const flatWalls: FlatWall[] = floorWalls.map((w, i) => {
    const id = `w${i}`;
    wallsById.set(id, w);
    wallIndexOf.set(w, id);
    return {
      id,
      corner1: idForCorner(w.getStart()),
      corner2: idForCorner(w.getEnd()),
      heightCm: w.height,
    };
  });

  const walked = wallWalkOrder(corners, flatWalls);
  const walkedById = new Map(walked.map((w) => [w.id, w]));

  const byWall = new Map<string, FlatLayoutItem[]>();
  const itemsById = new Map<string, StudioItem>();
  let n = 0;
  for (const item of bp.model.scene.getItems()) {
    const cfg = item.metadata?.unitConfig as UnitConfig | undefined;
    if (!cfg?.panels?.length) continue; // shelves, and legacy items with no config yet
    const wall = item.currentWallEdge?.wall;
    const wallId = wall ? wallIndexOf.get(wall) : undefined;
    if (!wallId || !wall) continue; // not attached yet (mid-load) — next render picks it up

    const sx = wall.getStartX();
    const sy = wall.getStartY();
    const ex = wall.getEndX();
    const ey = wall.getEndY();
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const widthCm = unitWidthMm(cfg) / 10;
    const heightCm = cfg.heightMm / 10;
    const centerAlongCm = (item.position.x - sx) * ux + (item.position.z - sy) * uy;

    const itemId = `i${n++}`;
    itemsById.set(itemId, item);
    const list = byWall.get(wallId) ?? [];
    list.push({
      id: itemId,
      name: item.metadata?.itemName ?? "Unit",
      kind: cfg.kind,
      offsetFromCorner1Cm: centerAlongCm - widthCm / 2,
      widthCm,
      heightCm,
      sillCm: Math.max(0, item.position.y - heightCm / 2),
    });
    byWall.set(wallId, list);
  }

  let tallestHeightCm = 0;
  const wallInputs: FlatLayoutWallInput[] = walked.map((w) => {
    const wall = wallsById.get(w.id)!;
    const lengthCm = Math.hypot(
      wall.getEndX() - wall.getStartX(),
      wall.getEndY() - wall.getStartY(),
    );
    if (w.heightCm > tallestHeightCm) tallestHeightCm = w.heightCm;
    return {
      id: w.id,
      lengthCm,
      heightCm: w.heightCm,
      loop: w.loop,
      reversed: w.reversed,
      items: byWall.get(w.id) ?? [],
    };
  });

  return { wallInputs, wallsById, walkedById, itemsById, tallestHeightCm };
}

interface DragState {
  itemId: string;
  /** clientX minus the item's row-content-space left edge, at grab time —
   * held constant through the drag so the item doesn't "jump" to be
   * centered under the pointer. */
  grabDx: number;
  startClientX: number;
  moved: boolean;
  widthCm: number;
  heightCm: number;
  sillCm: number;
}

export function FlatElevationsView({
  bp,
  selUnit,
  onSelectUnit,
  onCommitMove,
}: {
  bp: Blueprint3d | null;
  /** The Selected-unit panel's current item, if any — highlighted here too
   * so selection reads the same across every view. */
  selUnit: StudioItem | null;
  onSelectUnit: (item: StudioItem) => void;
  /** Final plan-space x/z, cm. ModelStudio.tsx wires this to the same
   * pushUndo → position.set → placeInRoom → snapIfCorner → growWallToFit
   * sequence every other move already uses. */
  onCommitMove: (item: StudioItem, xCm: number, zCm: number) => void;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [stageH, setStageH] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [ghost, setGhost] = useState<DropTarget | null>(null);

  useEffect(() => {
    const el = outerRef.current;
    if (!el || !("ResizeObserver" in window)) return;
    const ro = new ResizeObserver(() => setStageH(el.clientHeight));
    ro.observe(el);
    setStageH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Recomputed on every render — deliberately not memoized. A floor's wall
  // + item count is small (real floors run to dozens, not thousands), so
  // re-adapting on every pointermove during a drag costs nothing that
  // matters, and it buys a real guarantee: this view can never show a
  // stale frame, because it never caches one — same as the always-live 2D
  // canvas and 3D scene, just re-read instead of re-drawn.
  const gathered = bp ? gatherFloor(bp) : null;
  const tallestHeightCm = gathered?.tallestHeightCm ?? 0;
  const scale =
    stageH > 0 && tallestHeightCm > 0
      ? (stageH * FIT_FRACTION) / tallestHeightCm
      : FALLBACK_SCALE_PX_PER_CM;
  const layout = flatLayout(gathered?.wallInputs ?? [], scale);

  const rowXFromClient = (clientX: number) => {
    const el = outerRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return clientX - r.left + el.scrollLeft;
  };

  const beginDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    itemId: string,
    rowLeftX: number,
    widthCm: number,
    heightCm: number,
    sillCm: number,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      itemId,
      grabDx: rowXFromClient(e.clientX) - rowLeftX,
      startClientX: e.clientX,
      moved: false,
      widthCm,
      heightCm,
      sillCm,
    });
    setGhost(null);
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.startClientX) < DRAG_THRESHOLD_PX) return;
    if (!drag.moved) setDrag({ ...drag, moved: true });
    const dragLeftX = rowXFromClient(e.clientX) - drag.grabDx;
    setGhost(dropTarget(layout, dragLeftX, drag.widthCm));
  };

  const endDrag = () => {
    if (!drag) return;
    const { itemId, widthCm, moved } = drag;
    const finalGhost = ghost;
    setDrag(null);
    setGhost(null);
    if (!gathered) return;

    if (!moved) {
      const item = gathered.itemsById.get(itemId);
      if (item) onSelectUnit(item);
      return;
    }
    if (!finalGhost) return; // released before crossing the drag threshold

    const item = gathered.itemsById.get(itemId);
    const targetWalked = gathered.walkedById.get(finalGhost.wallId);
    const targetWall = gathered.wallsById.get(finalGhost.wallId);
    if (!item || !targetWalked || !targetWall) return;

    const sx = targetWall.getStartX();
    const sy = targetWall.getStartY();
    const ex = targetWall.getEndX();
    const ey = targetWall.getEndY();
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    // dropTarget's offset is in WALK direction; un-flip it back to the
    // wall's stored corner1→corner2 direction before turning it into a
    // plan point (the same flip flatLayout applies, run in reverse).
    const rawLeftCm = targetWalked.reversed
      ? len - finalGhost.offsetCm - widthCm
      : finalGhost.offsetCm;
    const centerCm = rawLeftCm + widthCm / 2;
    onCommitMove(item, sx + ux * centerCm, sy + uy * centerCm);
  };

  if (!bp) return null;

  if (!gathered) {
    return (
      <div className="studio-flat studio-flat-empty" ref={outerRef}>
        <p className="muted">No walls on this floor yet — draw the plan in 2D first.</p>
      </div>
    );
  }

  const manyBuildings = new Set(layout.panels.map((p) => p.loop)).size > 1;

  return (
    <div
      className="studio-flat"
      ref={outerRef}
      onPointerMove={onMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className="studio-flat-row"
        style={{ width: Math.max(layout.totalWidth, 1), height: Math.max(layout.maxHeight, 1) }}
      >
        {layout.panels.map((panel, i) => {
          const prev = layout.panels[i - 1];
          const showDivider = manyBuildings && (!prev || prev.loop !== panel.loop);
          return (
            <div key={panel.wallId}>
              {showDivider && (
                <div
                  className="studio-flat-divider"
                  // Centered in the gap before this building's first wall —
                  // except the very first one, which has no gap to center
                  // in (panel.x is 0) and would otherwise sit at a negative
                  // offset, clipped by the row's own left edge.
                  style={{ left: i === 0 ? 0 : panel.x - BUILDING_GAP_PX / 2 }}
                >
                  <span>Building {panel.loop + 1}</span>
                </div>
              )}
              <div
                className="studio-flat-wall"
                style={{ left: panel.x, width: panel.width, height: panel.height }}
              >
                {panel.items.map((it) => {
                  const liveItem = gathered.itemsById.get(it.id);
                  const selected = Boolean(selUnit && liveItem === selUnit);
                  return (
                    <div
                      key={it.id}
                      className={
                        "studio-flat-item" +
                        (it.kind === "door" ? " door" : "") +
                        (drag?.itemId === it.id && drag.moved ? " dragging" : "") +
                        (selected ? " selected" : "")
                      }
                      style={{
                        left: it.rect.x,
                        top: it.rect.y,
                        width: it.rect.width,
                        height: it.rect.height,
                      }}
                      onPointerDown={(e) => {
                        if (!liveItem) return;
                        const cfg = liveItem.metadata?.unitConfig as UnitConfig | undefined;
                        if (!cfg) return;
                        const widthCm = unitWidthMm(cfg) / 10;
                        const heightCm = cfg.heightMm / 10;
                        const sillCm = Math.max(0, liveItem.position.y - heightCm / 2);
                        beginDrag(e, it.id, panel.x + it.rect.x, widthCm, heightCm, sillCm);
                      }}
                    >
                      <span className="studio-flat-item-chip">{it.name}</span>
                    </div>
                  );
                })}
                {/* Nested in its TARGET wall's div, not the row — same
                    wall-local coordinate space every item rect already
                    uses, so no extra "which panel's top sits how far down
                    the row" math is needed here. dropTarget already
                    clamped offsetCm to fit inside this wall, so the ghost
                    is always a valid rect within it. */}
                {ghost && drag && ghost.wallId === panel.wallId && (
                  <div
                    className="studio-flat-ghost"
                    style={{
                      left: ghost.offsetCm * layout.scale,
                      top: (panel.heightCm - (drag.sillCm + drag.heightCm)) * layout.scale,
                      width: drag.widthCm * layout.scale,
                      height: drag.heightCm * layout.scale,
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
