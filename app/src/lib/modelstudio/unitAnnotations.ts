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
//
// Studio live overlays (liveOverlay.ts) ride the SAME plane rather than a
// mesh of their own — the lighter-weight option for phone memory, and it
// means a unit with no live signal costs exactly what it cost before this
// feature shipped: `overlay` is optional, and every overlay draw below is
// gated on it being present.

import * as THREE from "three";
import {
  cornerLegs,
  panelsWidthMm,
  rowHeightsCm,
  slideCountOf,
  type UnitConfig,
  type UnitPanel,
} from "./units";
import { cornerGeometryInfo, UNIT_GEOMETRY_DEFAULTS } from "./unitGeometry";
import { inches } from "../fitview/fitviewRenderer";
import type { OverlayState } from "./liveOverlay";

const MM_TO_CM = 0.1;
/** Canvas oversampling — the map uses a 3x trick for sharp text. */
const PX_PER_CM = 3;
/** Headroom above the frame for the mark chip, cm. */
const CHIP_BAND_CM = 22;
/** Vertical space one overlay badge line (blocked/loose/parts) takes, cm. */
const OVERLAY_LINE_CM = 15;
/** Padding above/below the badge stack, cm. */
const OVERLAY_PAD_CM = 3;
/** Status-glow hex, pinned to the SAME values fitview.css uses for the map
 * (--gl-red/yellow/green) — the Studio must never show a different red
 * than the map does for the same opening. */
const GLOW_HEX: Record<"red" | "yellow" | "green", string> = {
  red: "#e4655c",
  yellow: "#e8c14a",
  green: "#35b98d",
};
/** Flashing-owed accent, pinned to fitview.css's --fl-needed (dashed aqua
 * on the map; same color here, dashed stroke does the rest). */
const FLASH_OWED_HEX = "#2a8d81";

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
  /** Multi-track slide count — drawn as "×n" beside the arrow when ≥2. */
  count?: number;
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
        if (kind) {
          const count = slideCountOf(p);
          glyphs.push({ kind, x, y, w: pw, h: rh, count: count > 1 ? count : undefined });
        }
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
  /** Blocked-marker red (theme --danger — deliberately NOT the same red
   * glowFor uses; blocked is its own small badge, not a frame tint). */
  danger: string;
  /** Loose-alarm amber (theme --warn). */
  warn: string;
}

function resolvePaint(): Paint {
  try {
    const css = getComputedStyle(document.documentElement);
    return {
      accent: css.getPropertyValue("--info").trim() || "#4a9dff",
      ink: css.getPropertyValue("--ink").trim() || "#f2e9e2",
      pill: "rgba(20, 16, 13, 0.85)",
      danger: css.getPropertyValue("--danger").trim() || "#c93a32",
      warn: css.getPropertyValue("--warn").trim() || "#e8a23d",
    };
  } catch {
    return {
      accent: "#4a9dff",
      ink: "#f2e9e2",
      pill: "rgba(20,16,13,0.85)",
      danger: "#c93a32",
      warn: "#e8a23d",
    };
  }
}

/** Dark halo behind every glyph stroke — the owner's redesign (2026-08-14:
 * the dashed arrows were "not obvious, and are hard to see"): each shape is
 * stroked twice, a fat dark underlay then the opaque accent on top, so it
 * reads against glass, sky and framing alike. */
const HALO = "rgba(10, 8, 6, 0.85)";

function strokeBold(ctx: CanvasRenderingContext2D, accent: string, trace: () => void) {
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = HALO;
  ctx.lineWidth = 8;
  ctx.beginPath();
  trace();
  ctx.stroke();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  trace();
  ctx.stroke();
}

/** Filled chevron arrowhead at (tipX, tipY) pointing along dir (±1 in x). */
function fillHead(
  ctx: CanvasRenderingContext2D,
  accent: string,
  tipX: number,
  tipY: number,
  dx: number,
  dy: number,
) {
  const trace = () => {
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - dx * 16 - dy * 9, tipY - dy * 16 + dx * 9);
    ctx.lineTo(tipX - dx * 16 + dy * 9, tipY - dy * 16 - dx * 9);
    ctx.closePath();
  };
  ctx.globalAlpha = 1;
  ctx.lineJoin = "round";
  ctx.strokeStyle = HALO;
  ctx.lineWidth = 6;
  ctx.beginPath();
  trace();
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.beginPath();
  trace();
  ctx.fill();
}

/** Halo-backed text — the same two-pass trick for letters and ×n badges. */
function boldText(
  ctx: CanvasRenderingContext2D,
  accent: string,
  text: string,
  x: number,
  y: number,
  fontPx: number,
) {
  ctx.globalAlpha = 1;
  ctx.font = `700 ${fontPx}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.strokeStyle = HALO;
  ctx.lineWidth = 5;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = accent;
  ctx.fillText(text, x, y);
}

function drawGlyph(ctx: CanvasRenderingContext2D, g: GlyphOp, paint: Paint) {
  const px = (v: number) => v * PX_PER_CM;
  const cx = px(g.x + g.w / 2);
  const cy = px(CHIP_BAND_CM + g.y + g.h / 2);
  // Minimum size floor: a small pane still gets a legible arrow.
  const a = Math.max(16, Math.min(px(g.w), px(g.h)) * 0.3);
  ctx.save();
  if (g.kind === "fixed") {
    boldText(ctx, paint.accent, "F", cx, cy, Math.max(22, a * 0.9));
    ctx.restore();
    return;
  }
  if (g.kind === "arrow-left" || g.kind === "arrow-right") {
    const dir = g.kind === "arrow-left" ? -1 : 1;
    strokeBold(ctx, paint.accent, () => {
      ctx.moveTo(cx - a * dir, cy);
      ctx.lineTo(cx + (a - 12) * dir, cy);
    });
    fillHead(ctx, paint.accent, cx + a * dir, cy, dir, 0);
    if (g.count && g.count > 1) {
      // Multi-track: ×n rides above the shaft, clear of the head.
      boldText(ctx, paint.accent, `×${g.count}`, cx - 4 * dir, cy - 20, 17);
    }
  } else if (g.kind === "hinge-left" || g.kind === "hinge-right") {
    // Sight-lines converging at the hinge side (trade standard), now
    // solid + haloed so the V reads at a glance.
    const hingeX = g.kind === "hinge-left" ? px(g.x) + 5 : px(g.x + g.w) - 5;
    const farX = g.kind === "hinge-left" ? px(g.x + g.w) - 5 : px(g.x) + 5;
    const top = px(CHIP_BAND_CM + g.y) + 5;
    const bot = px(CHIP_BAND_CM + g.y + g.h) - 5;
    strokeBold(ctx, paint.accent, () => {
      ctx.moveTo(farX, top);
      ctx.lineTo(hingeX, cy);
      ctx.lineTo(farX, bot);
    });
  } else if (g.kind === "up-arrow") {
    strokeBold(ctx, paint.accent, () => {
      ctx.moveTo(cx, cy + a);
      ctx.lineTo(cx, cy - a + 12);
    });
    fillHead(ctx, paint.accent, cx, cy - a, 0, -1);
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

// --------------------------------------------------------- live overlays
// liveOverlay.ts hands over a plain data bag (OverlayState); everything
// below is the ONE place that decides what it looks like. Precedence, top
// to bottom: dim scrim first (a background wash everything else still
// shows through), then the status border + halo, then the existing
// glyphs/labels untouched, then the flashing outline, then the badges —
// so an urgent signal (blocked, loose) is never the layer a dim scrim or
// a glow tint could bury.

/** Frame rect in canvas pixels: the glass+frame area below the chip band,
 * excluding whatever badge band the unit also carries. */
function frameRectPx(wPx: number, legHcm: number): { w: number; h: number } {
  return { w: wPx, h: Math.round((legHcm + CHIP_BAND_CM) * PX_PER_CM) };
}

/**
 * Dim (#17) + status glow/QC halo (#1, #6) — drawn UNDER the trade glyphs,
 * across the whole frame rect (both legs on a corner unit; envelope state
 * is true of the whole physical unit, not just the leg carrying the mark).
 */
function paintOverlayBackdrop(
  ctx: CanvasRenderingContext2D,
  wPx: number,
  legHcm: number,
  overlay: OverlayState,
) {
  const top = CHIP_BAND_CM * PX_PER_CM;
  const { h } = frameRectPx(wPx, legHcm);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  if (overlay.dim) {
    ctx.fillStyle = "rgba(10, 8, 6, 0.45)";
    ctx.fillRect(0, top, wPx, h - top);
  }
  if (overlay.glow && overlay.glow !== "none") {
    const color = GLOW_HEX[overlay.glow];
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    // QC (green) gets a visibly bigger halo — item #6's "distinct visual"
    // on top of the glow data it shares with #1, not a second query.
    ctx.shadowColor = color;
    ctx.shadowBlur = overlay.glow === "green" ? 26 : 12;
    ctx.strokeRect(4, top + 4, wPx - 8, h - top - 8);
  }
  ctx.restore();
}

/** Flashing-owed (#5): a second, dashed, aqua outline — its own channel,
 * apart from the glow fill, exactly like the map's flash-needed frame. */
function paintOverlayFlashing(
  ctx: CanvasRenderingContext2D,
  wPx: number,
  legHcm: number,
  overlay: OverlayState,
) {
  if (!overlay.flashingOwed) return;
  const top = CHIP_BAND_CM * PX_PER_CM;
  const { h } = frameRectPx(wPx, legHcm);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = FLASH_OWED_HEX;
  ctx.lineWidth = 4;
  ctx.setLineDash([10, 8]);
  ctx.strokeRect(11, top + 11, wPx - 22, h - top - 22);
  ctx.restore();
}

/** Photo pin (#7): a small 📷N pill in the chip band's top-right corner —
 * the mark chip already owns the top-left (drawLabel's "mark" case), so
 * this never crowds it. Count only, never a URL: the thumbnails themselves
 * are signed lazily, only once somebody selects the unit. */
function paintPhotoBadge(ctx: CanvasRenderingContext2D, wPx: number, count: number) {
  const text = `📷 ${count}`;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.font = "700 18px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width + 18;
  const y = (CHIP_BAND_CM / 2) * PX_PER_CM;
  const cx = wPx - w / 2 - 6;
  ctx.fillStyle = "rgba(20, 16, 13, 0.85)";
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, y - 15, w, 30, 6);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, cx, y);
  ctx.restore();
}

interface OverlayBadgeLine {
  text: string;
  color: string;
}

/** Blocked (#3), loose (#19) and the parts line (#4) — one line each, most
 * urgent first. Main leg only (same convention the mark chip already
 * uses): repeating them on the wrap leg would be the same fact twice. */
function overlayBadgeLines(overlay: OverlayState, paint: Paint): OverlayBadgeLine[] {
  const lines: OverlayBadgeLine[] = [];
  if (overlay.blockedReason !== undefined) {
    lines.push({
      text: `⚠ Blocked — ${overlay.blockedReason ?? "no reason given"}`,
      color: paint.danger,
    });
  }
  if (overlay.loose) {
    lines.push({ text: "❓ Loose — no container, no slot", color: paint.warn });
  }
  if (overlay.partsLine) {
    lines.push({ text: overlay.partsLine, color: paint.ink });
  }
  return lines;
}

/** Total extra canvas height the badge band needs, cm. Zero when there's
 * nothing to say — most units, most of the time. */
function overlayBandCm(lines: OverlayBadgeLine[]): number {
  return lines.length === 0 ? 0 : lines.length * OVERLAY_LINE_CM + OVERLAY_PAD_CM * 2;
}

function paintOverlayBadges(
  ctx: CanvasRenderingContext2D,
  wPx: number,
  legHcm: number,
  lines: OverlayBadgeLine[],
) {
  const px = (v: number) => v * PX_PER_CM;
  const { h: frameBottomPx } = frameRectPx(wPx, legHcm);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "600 15px ui-monospace, monospace";
  ctx.lineJoin = "round";
  let y = frameBottomPx + px(OVERLAY_PAD_CM) + px(OVERLAY_LINE_CM) / 2;
  const maxW = wPx - px(8);
  for (const line of lines) {
    ctx.strokeStyle = HALO;
    ctx.lineWidth = 4;
    ctx.strokeText(line.text, px(4), y, maxW);
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, px(4), y, maxW);
    y += px(OVERLAY_LINE_CM);
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
  o: { mark?: string | null; dims: boolean; overlay?: OverlayState },
): THREE.Mesh[] {
  const paint = resolvePaint();
  const layouts = annotationLayout(config, o);
  const corner = cornerGeometryInfo(config);
  const depth = UNIT_GEOMETRY_DEFAULTS.depthMm * MM_TO_CM;
  // Badges (blocked/loose/parts) need a strip below the frame; most units
  // carry none of these, so `bandCm` is 0 and every line below collapses
  // to exactly what shipped before overlays existed.
  const badgeLines = o.overlay ? overlayBadgeLines(o.overlay, paint) : [];
  const bandCm = overlayBandCm(badgeLines);

  return layouts.map((lay) => {
    const showBadges = lay.leg === "main" && badgeLines.length > 0;
    const legBandCm = showBadges ? bandCm : 0;
    const wPx = Math.min(2048, Math.round(lay.legWcm * PX_PER_CM));
    const hPx = Math.min(
      2048,
      Math.round((lay.legHcm + CHIP_BAND_CM + legBandCm) * PX_PER_CM),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(8, wPx);
    canvas.height = Math.max(8, hPx);
    const ctx = canvas.getContext("2d")!;
    if (o.overlay) paintOverlayBackdrop(ctx, wPx, lay.legHcm, o.overlay);
    for (const g of lay.glyphs) drawGlyph(ctx, g, paint);
    for (const l of lay.labels) drawLabel(ctx, l, paint);
    if (o.overlay) paintOverlayFlashing(ctx, wPx, lay.legHcm, o.overlay);
    if (showBadges) paintOverlayBadges(ctx, wPx, lay.legHcm, badgeLines);
    // Photo pin: main leg only, same convention the mark chip uses — a
    // corner unit's photos belong to the whole physical opening.
    if (lay.leg === "main" && o.overlay?.photoCount) {
      paintPhotoBadge(ctx, wPx, o.overlay.photoCount);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 8;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geo = new THREE.PlaneGeometry(lay.legWcm, lay.legHcm + CHIP_BAND_CM + legBandCm);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "unit-annotations";
    mesh.renderOrder = 5;
    // Vertical centering: the plane spans H + chip band (+ the badge band,
    // when this leg carries one) — shift up so the glass area still
    // aligns and the chip still floats above the frame exactly as before;
    // the badge band (if any) hangs below, off the bottom of the frame.
    const yOff = CHIP_BAND_CM / 2 - legBandCm / 2;

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
