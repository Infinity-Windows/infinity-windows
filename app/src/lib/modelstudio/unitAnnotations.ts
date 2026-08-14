// Map-parity annotations painted ONTO each unit in the Studio 3D view
// (owner ask, from his Maps Interactive screenshot): dashed arrows on
// panes that open (direction-aware), the dashed hinge-V on casements, an
// up-arrow on hung sash, "F" on fixed panes, per-pane widths along the
// head, the W×L pill, and the numbered mark chip above the frame.
//
// The interactive map draws these as DOM/SVG (it's a CSS-3D scene); the
// Studio is real three.js, so the faithful port is one transparent
// CanvasTexture plane per unit leg, hung as a child of the item. Layout is
// PURE (unit-tested); only the painter touches a canvas.

import * as THREE from "three";
import {
  cornerLegs,
  panelsWidthMm,
  rowHeightsCm,
  type UnitConfig,
  type UnitPanel,
} from "./units";
import { cornerGeometryInfo, UNIT_GEOMETRY_DEFAULTS } from "./unitGeometry";
import { inches } from "../fitview/fitviewRenderer";

const MM_TO_CM = 0.1;
/** Canvas oversampling — the map uses a 3x trick for sharp text. */
const PX_PER_CM = 3;
/** Headroom above the frame for the mark chip, cm. */
const CHIP_BAND_CM = 22;

export type GlyphKind =
  | "arrow-left"
  | "arrow-right"
  | "hinge-left"
  | "hinge-right"
  | "up-arrow"
  | "fixed";

export interface GlyphOp {
  kind: GlyphKind;
  /** Pane rect in OUTSIDE-VIEW leg coords: x from the leg's left edge, y
   * from the TOP of the frame, cm. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelOp {
  kind: "panedim" | "wl" | "mark";
  text: string;
  x: number;
  y: number;
  vertical?: boolean;
}

export interface LegLayout {
  /** Leg face size, cm. */
  legWcm: number;
  legHcm: number;
  glyphs: GlyphOp[];
  labels: LabelOp[];
  /** Which leg: main (on the item's wall) or the corner wrap. */
  leg: "main" | "wrap";
}

function glyphFor(p: UnitPanel): GlyphKind | null {
  switch (p.mechanism) {
    case "fixed":
      return "fixed";
    case "slider":
    case "bifold":
      return p.direction === "left" ? "arrow-left" : "arrow-right";
    case "casement":
      return p.direction === "left" ? "hinge-left" : "hinge-right";
    case "hung":
      return "up-arrow";
    default:
      return null;
  }
}

/**
 * PURE layout: pane rects + glyphs + labels per leg, in outside-view
 * coordinates (x left→right exactly as the drawing reads). `dims` gates
 * the measurement labels (owner pick: marks always, dims on selection).
 */
export function annotationLayout(
  config: UnitConfig,
  o: { mark?: string | null; dims: boolean },
): LegLayout[] {
  const H = config.heightMm * MM_TO_CM;
  const rows = rowHeightsCm(config);
  const corner = cornerGeometryInfo(config);
  const legs = cornerLegs(config);

  const legDefs: { panels: UnitPanel[]; leg: "main" | "wrap" }[] =
    corner && legs
      ? corner.sideSign === 1
        ? [
            { panels: legs.right, leg: "main" },
            { panels: legs.left, leg: "wrap" },
          ]
        : [
            { panels: legs.left, leg: "main" },
            { panels: legs.right, leg: "wrap" },
          ]
      : [{ panels: config.panels, leg: "main" }];

  return legDefs.map(({ panels, leg }) => {
    const W = panelsWidthMm(panels) * MM_TO_CM;
    const glyphs: GlyphOp[] = [];
    const labels: LabelOp[] = [];

    let x = 0;
    panels.forEach((p) => {
      const pw = p.widthMm * MM_TO_CM;
      // One glyph per pane CELL (rows share the column's mechanism).
      let y = 0;
      rows.forEach((rh) => {
        const kind = glyphFor(p);
        if (kind) glyphs.push({ kind, x, y, w: pw, h: rh });
        y += rh;
      });
      if (o.dims) {
        labels.push({
          kind: "panedim",
          text: inches(p.widthMm),
          x: x + pw / 2,
          y: 6,
          vertical: pw < 26,
        });
      }
      x += pw;
    });

    if (o.dims) {
      labels.push({
        kind: "wl",
        text: `W ${inches(panelsWidthMm(panels))}  ·  L ${inches(config.heightMm)}`,
        x: W / 2,
        y: H / 2,
      });
    }
    if (o.mark && leg === "main") {
      labels.push({ kind: "mark", text: o.mark, x: 4, y: -8 });
    }

    return { legWcm: W, legHcm: H, glyphs, labels, leg };
  });
}

// ------------------------------------------------------------- painter

interface Paint {
  accent: string;
  ink: string;
  pill: string;
}

function resolvePaint(): Paint {
  try {
    const css = getComputedStyle(document.documentElement);
    return {
      accent: css.getPropertyValue("--info").trim() || "#4a9dff",
      ink: css.getPropertyValue("--ink").trim() || "#f2e9e2",
      pill: "rgba(20, 16, 13, 0.85)",
    };
  } catch {
    return { accent: "#4a9dff", ink: "#f2e9e2", pill: "rgba(20,16,13,0.85)" };
  }
}

function dashed(ctx: CanvasRenderingContext2D, paint: Paint) {
  ctx.strokeStyle = paint.accent;
  ctx.lineWidth = 2.4;
  ctx.setLineDash([9, 7.5]); // the map's 3/2.5 at 3x
  ctx.globalAlpha = 0.7;
}

function drawGlyph(ctx: CanvasRenderingContext2D, g: GlyphOp, paint: Paint) {
  const px = (v: number) => v * PX_PER_CM;
  const cx = px(g.x + g.w / 2);
  const cy = px(CHIP_BAND_CM + g.y + g.h / 2);
  const a = Math.min(px(g.w), px(g.h)) * 0.26;
  ctx.save();
  if (g.kind === "fixed") {
    ctx.fillStyle = paint.accent;
    ctx.globalAlpha = 0.75;
    ctx.font = `600 ${Math.max(16, a * 0.9)}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("F", cx, cy);
    ctx.restore();
    return;
  }
  dashed(ctx, paint);
  ctx.beginPath();
  if (g.kind === "arrow-left" || g.kind === "arrow-right") {
    const dir = g.kind === "arrow-left" ? -1 : 1;
    ctx.moveTo(cx - a * dir, cy);
    ctx.lineTo(cx + a * dir, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.setLineDash([]);
    ctx.moveTo(cx + a * dir, cy);
    ctx.lineTo(cx + a * dir - 10 * dir, cy - 7);
    ctx.moveTo(cx + a * dir, cy);
    ctx.lineTo(cx + a * dir - 10 * dir, cy + 7);
    ctx.stroke();
  } else if (g.kind === "hinge-left" || g.kind === "hinge-right") {
    // Dashed sight-lines converging at the hinge side (trade standard).
    const hingeX = g.kind === "hinge-left" ? px(g.x) + 3 : px(g.x + g.w) - 3;
    const farX = g.kind === "hinge-left" ? px(g.x + g.w) - 3 : px(g.x) + 3;
    const top = px(CHIP_BAND_CM + g.y) + 3;
    const bot = px(CHIP_BAND_CM + g.y + g.h) - 3;
    ctx.moveTo(farX, top);
    ctx.lineTo(hingeX, cy);
    ctx.lineTo(farX, bot);
    ctx.stroke();
  } else if (g.kind === "up-arrow") {
    ctx.moveTo(cx, cy + a);
    ctx.lineTo(cx, cy - a);
    ctx.stroke();
    ctx.beginPath();
    ctx.setLineDash([]);
    ctx.moveTo(cx, cy - a);
    ctx.lineTo(cx - 7, cy - a + 10);
    ctx.moveTo(cx, cy - a);
    ctx.lineTo(cx + 7, cy - a + 10);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLabel(ctx: CanvasRenderingContext2D, l: LabelOp, paint: Paint) {
  const px = (v: number) => v * PX_PER_CM;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (l.kind === "panedim") {
    ctx.fillStyle = paint.ink;
    ctx.globalAlpha = 0.9;
    ctx.font = "500 13px ui-monospace, monospace";
    const x = px(l.x);
    const y = px(CHIP_BAND_CM + l.y);
    if (l.vertical) {
      ctx.translate(x, y + 16);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(l.text, 0, 0);
    } else {
      ctx.fillText(l.text, x, y);
    }
  } else if (l.kind === "wl") {
    ctx.font = "600 17px ui-monospace, monospace";
    const w = ctx.measureText(l.text).width + 22;
    const x = px(l.x);
    const y = px(CHIP_BAND_CM + l.y);
    ctx.fillStyle = paint.pill;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 15, w, 30, 6);
    ctx.fill();
    ctx.fillStyle = paint.ink;
    ctx.fillText(l.text, x, y);
  } else {
    // mark chip: white on accent, above the frame in the headroom band.
    ctx.font = "700 20px ui-monospace, monospace";
    const w = ctx.measureText(l.text).width + 20;
    const x = px(l.x) + w / 2;
    const y = px(CHIP_BAND_CM / 2);
    ctx.fillStyle = paint.accent;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 15, w, 30, 6);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(l.text, x, y);
  }
  ctx.restore();
}

/**
 * Build one annotation plane per leg. Planes face OUTSIDE (local -z), the
 * side spec drawings read from; the canvas is painted in outside-view
 * order and the π Y-rotation maps canvas-left onto local +x (the outside
 * viewer's left), keeping glyph order true.
 */
export function buildUnitAnnotations(
  config: UnitConfig,
  o: { mark?: string | null; dims: boolean },
): THREE.Mesh[] {
  const paint = resolvePaint();
  const layouts = annotationLayout(config, o);
  const corner = cornerGeometryInfo(config);
  const depth = UNIT_GEOMETRY_DEFAULTS.depthMm * MM_TO_CM;

  return layouts.map((lay) => {
    const wPx = Math.min(2048, Math.round(lay.legWcm * PX_PER_CM));
    const hPx = Math.min(
      2048,
      Math.round((lay.legHcm + CHIP_BAND_CM) * PX_PER_CM),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(8, wPx);
    canvas.height = Math.max(8, hPx);
    const ctx = canvas.getContext("2d")!;
    for (const g of lay.glyphs) drawGlyph(ctx, g, paint);
    for (const l of lay.labels) drawLabel(ctx, l, paint);

    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 8;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geo = new THREE.PlaneGeometry(lay.legWcm, lay.legHcm + CHIP_BAND_CM);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "unit-annotations";
    mesh.renderOrder = 5;
    // Vertical centering: the plane spans H + chip band; shift up so the
    // glass area aligns and the chip floats above the frame.
    const yOff = CHIP_BAND_CM / 2;

    if (lay.leg === "main" || !corner) {
      mesh.position.set(0, yOff, -(depth / 2 + 1));
      mesh.rotation.y = Math.PI;
    } else {
      // Wrap leg: same placement math as buildRun's wrap run — at the
      // corner end, running along local +z, face pointing away from the
      // main wall's outside (local -x for a left wrap, +x for right).
      const xC = corner.sideSign * (corner.mainWcm / 2);
      const zMid = depth / 2 + corner.wrapWcm / 2;
      mesh.position.set(xC + corner.sideSign * (depth / 2 + 1), yOff, zMid);
      mesh.rotation.y = corner.sideSign === 1 ? Math.PI / 2 : -Math.PI / 2;
    }
    return mesh;
  });
}
