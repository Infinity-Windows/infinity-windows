// Infinity → fit-view adapter.
//
// The 3D fit view (ported from the window-viewer prototype, see
// fitviewRenderer.ts) consumes the prototype's job JSON: a building described
// in METERS (footprint polygon, wall height) and windows placed per wall
// (elev key + meters along the wall + real mm sizes). Infinity stores none of
// that directly — it has a plan outline in normalized page coordinates, opening
// pins on the same page, and spec sizes in inches. This module is the bridge,
// and it is deliberately pure so the mapping rules are unit-testable.
//
// Known v1 approximations, on purpose (a visual aid, not a survey record):
//  - SCALE. Plan pages carry no absolute scale, so the footprint's longest
//    bbox side is pinned to DEFAULT_LONG_SIDE_M. Everything else stays
//    proportional. A later phase can store a measured scale per outline.
//  - SILL HEIGHTS. Nothing in Infinity records how high off the floor a window
//    sits; windows get DEFAULT_SILL_M, doors sit on the floor. Clamped so tall
//    units never poke through the wall head.
//  - HARDWARE. Panel count / swing is inferred from the spec `operation`
//    string and style text (see inferHardware). Unknown reads as fixed —
//    wrong-but-quiet beats wrong-and-loud on a reference model.

import { nearestPointOnOutline } from "../install/cad";
import { absoluteSill, storiesOf } from "./stories";
import type { OutlinePoint } from "../install/outline";
import { markBase } from "../install/extract";
import type { ProjectMarkSpec } from "../install/specs";
import type { ProjectOpening } from "../install/types";

export interface FitViewWindow {
  id: string;
  elev: string;
  floor: string;
  room: string;
  type: string;
  /** Order size in millimetres. */
  w: number;
  h: number;
  /** Metres along the wall from its start vertex. */
  x: number;
  /** Sill height above the floor, metres. Doors are 0. */
  y: number;
  lights: number;
  open: "fixed" | "hinge-l" | "hinge-r" | "hinge-t" | "bipart";
  status: "tofit" | "installed" | "issue";
  door?: boolean;
  hand?: string;
  glass?: string;
  frame?: string;
  notes?: string;
  assigned?: string[];
}

export interface FitViewJob {
  id: string;
  ref: string;
  addr: string;
  rev: number;
  building: {
    width: number;
    depth: number;
    height: number;
    rise: number;
    /** A vertex `name` labels the wall STARTING at it (survey convention). */
    footprints: { x: number; z: number; name?: string }[][];
  };
  windows: FitViewWindow[];
}

/** Longest bounding-box side of the footprint, metres, absent a real scale. */
export const DEFAULT_LONG_SIDE_M = 30;
/** Single-storey wall height default, metres. */
export const DEFAULT_WALL_HEIGHT_M = 3.6;
/** Window sill default, metres above the floor. */
export const DEFAULT_SILL_M = 0.9;
/** Order-size fallback when neither spec nor catalog knows: 36" x 48". */
const FALLBACK_W_MM = 914;
const FALLBACK_H_MM = 1219;

const IN_TO_MM = 25.4;

/** True when the unit stands on the floor rather than in the wall. */
export function isDoorLike(text: string): boolean {
  return /\bdoors?\b/i.test(text);
}

/**
 * Panel count + swing from the manufacturer's operation string and style text.
 * Operation letters read from OUTSIDE: X = operating, O = fixed ("XO", "OXXO").
 */
export function inferHardware(
  operation: string | null,
  styleText: string,
): { lights: number; open: FitViewWindow["open"] } {
  const op = (operation ?? "").trim().toUpperCase();
  const style = styleText.toLowerCase();

  // Letter strings give an exact panel count.
  if (/^[XO]{2,}$/.test(op)) {
    const lights = op.length;
    // A symmetric operating pair meeting in the middle parts outward.
    if (lights >= 4 && op === "OXXO") return { lights, open: "bipart" };
    // Sliders read best as bipart's arrow language; hinged pairs as leaves.
    if (style.includes("slid")) return { lights, open: "bipart" };
    return { lights, open: op[0] === "X" ? "hinge-l" : "hinge-r" };
  }

  if (op === "FIXED" || op === "O" || style.includes("fixed")) {
    return { lights: 1, open: "fixed" };
  }
  if (style.includes("french")) return { lights: 2, open: "hinge-r" };
  if (style.includes("casement")) return { lights: 1, open: "hinge-l" };
  if (style.includes("awning")) return { lights: 1, open: "hinge-t" };
  if (style.includes("slid")) return { lights: 2, open: "bipart" };
  // Hung windows travel vertically; the fit view has no vocabulary for that
  // yet, so show the two sashes without a misleading swing symbol.
  if (style.includes("hung")) return { lights: 2, open: "fixed" };
  return { lights: 1, open: "fixed" };
}

export interface AdapterInput {
  projectId: string;
  projectName: string;
  projectAddress: string | null;
  outline: {
    points: OutlinePoint[];
    pageAspect: number;
    pageNumber: number;
  };
  openings: ProjectOpening[];
  specs: ProjectMarkSpec[];
  /** Override the assumed footprint long side, metres. */
  longSideM?: number;
  /** Override the single-storey wall height, metres. */
  wallHeightM?: number;
}

/**
 * A complete hand-traced model (the window-viewer survey format) that an
 * outline row can carry in `features.fitview.model`: multi-mass footprints
 * with NAMED walls, and windows placed by a surveyor's hand rather than
 * derived from plan pins. When present it beats the pin-derived model in
 * every way that matters on site, so the tab prefers it wholesale.
 */
export interface AuthoredModel {
  building: {
    width: number;
    depth: number;
    height: number;
    rise: number;
    footprints: { x: number; z: number; name?: string }[][];
  };
  /** Renderer-native windows; extra fields (legs, wrap, panes…) pass through. */
  windows: Array<Record<string, unknown> & { id: string; status?: string }>;
}

export function fitviewModel(features: unknown): AuthoredModel | null {
  if (!features || typeof features !== "object") return null;
  const f = (features as { fitview?: unknown }).fitview;
  if (!f || typeof f !== "object") return null;
  const m = (f as { model?: unknown }).model;
  if (!m || typeof m !== "object") return null;
  const model = m as AuthoredModel;
  if (!Array.isArray(model.building?.footprints)) return null;
  if (!Array.isArray(model.windows)) return null;
  return model;
}

/**
 * One physical opening, two label dialects: Infinity's extraction writes the
 * QTY-2 twins as "13-1"/"13-2", the survey format as "13A"/"13B". Normalize
 * both to the dashed form so live status can find its window and vice versa.
 */
export function normalizeMarkCode(code: string): string {
  const t = code.trim().toUpperCase();
  const m = /^(.+?)([A-Z])$/.exec(t);
  if (m && /\d$/.test(m[1])) {
    return `${m[1]}-${m[2].charCodeAt(0) - 64}`;
  }
  return t;
}

/**
 * The authored model dressed with LIVE state: geometry and specs come from the
 * survey, install status comes from today's database rows so QC and the crew's
 * progress stay true. Unmatched windows keep their authored status.
 */
export function buildAuthoredJob(
  model: AuthoredModel,
  meta: { projectId: string; projectName: string; projectAddress: string | null },
  openings: ProjectOpening[],
): FitViewJob {
  const liveByCode = new Map<string, ProjectOpening>();
  for (const o of openings) liveByCode.set(normalizeMarkCode(o.opening_code), o);

  // Storied models keep sills relative to their own floor (edits stay local);
  // the renderer positions in absolute height, so the conversion happens
  // here, at the boundary, and nowhere else.
  const stories = storiesOf(model.building);
  const windows = model.windows.map((raw) => {
    const w = { ...raw, y: absoluteSill(raw as { y?: unknown; story?: unknown }, stories) };
    const live = liveByCode.get(normalizeMarkCode(String(w.id)));
    if (!live) return w;
    return {
      ...w,
      status: live.status === "installed" ? "installed" : "tofit",
      assigned: live.assignee?.display_name ? [live.assignee.display_name] : undefined,
    };
  });

  return {
    id: meta.projectId,
    ref: meta.projectName,
    addr: meta.projectAddress ?? "",
    rev: 1,
    building: model.building,
    windows: windows as unknown as FitViewWindow[],
  };
}

/**
 * Real-world calibration a seeded/traced outline can carry in its `features`
 * jsonb under a `fitview` key. parseOutlineFeatures ignores unknown keys, so
 * this rides alongside the CAD-lite dividers without disturbing them.
 */
export function fitviewCalibration(
  features: unknown,
): { longSideM?: number; wallHeightM?: number } {
  if (!features || typeof features !== "object") return {};
  const f = (features as { fitview?: unknown }).fitview;
  if (!f || typeof f !== "object") return {};
  const o = f as { longSideM?: unknown; wallHeightM?: unknown };
  const out: { longSideM?: number; wallHeightM?: number } = {};
  if (typeof o.longSideM === "number" && o.longSideM > 0) out.longSideM = o.longSideM;
  if (typeof o.wallHeightM === "number" && o.wallHeightM > 0) {
    out.wallHeightM = o.wallHeightM;
  }
  return out;
}

/**
 * Build the fit-view job, or null when the outline can't support one.
 * Only openings pinned on the outline's page are placed on the model.
 */
export function buildFitViewJob(input: AdapterInput): FitViewJob | null {
  const { outline } = input;
  if (!outline || outline.points.length < 3) return null;

  // Physical page space: x as-is, y stretched by the page's aspect so a square
  // on paper is a square in plan. (Same convention as cad.ts's toDisp.)
  const aspect = outline.pageAspect || 1;
  const phys = outline.points.map((p) => ({ x: p.x, z: p.y * aspect }));
  const xs = phys.map((p) => p.x);
  const zs = phys.map((p) => p.z);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanZ = Math.max(...zs) - Math.min(...zs);
  const span = Math.max(spanX, spanZ);
  if (span <= 0) return null;

  const scale = (input.longSideM ?? DEFAULT_LONG_SIDE_M) / span;
  const wallH = input.wallHeightM ?? DEFAULT_WALL_HEIGHT_M;
  const footprint = phys.map((p) => ({ x: p.x * scale, z: p.z * scale }));

  // Wall lengths in metres, matching elevationsOf()'s edge enumeration.
  const edgeLen: number[] = footprint.map((a, i) => {
    const b = footprint[(i + 1) % footprint.length];
    return Math.hypot(b.x - a.x, b.z - a.z);
  });

  const specByMark = new Map<string, ProjectMarkSpec>();
  for (const s of input.specs) specByMark.set(s.mark_code, s);

  const windows: FitViewWindow[] = [];
  for (const o of input.openings) {
    if (o.page_number !== outline.pageNumber) continue;
    if (o.pin_x == null || o.pin_y == null) continue;
    const hit = nearestPointOnOutline(
      outline.points,
      { x: o.pin_x, y: o.pin_y },
      aspect,
    );
    if (!hit) continue;

    const spec = specByMark.get(markBase(o.opening_code)) ?? null;
    const type = o.window_types ?? null;
    const wIn = spec?.width_in ?? type?.width_in ?? null;
    const hIn = spec?.height_in ?? type?.height_in ?? null;
    const wMm = wIn != null ? Math.round(wIn * IN_TO_MM) : FALLBACK_W_MM;
    const hMm = hIn != null ? Math.round(hIn * IN_TO_MM) : FALLBACK_H_MM;

    const styleText = [spec?.style, type?.name, type?.category]
      .filter(Boolean)
      .join(" ");
    const door = isDoorLike(styleText);
    const { lights, open } = inferHardware(spec?.operation ?? null, styleText);

    const hM = hMm / 1000;
    const sill = door
      ? 0
      : Math.max(
          0.15,
          Math.min(DEFAULT_SILL_M, wallH - hM - 0.2),
        );

    windows.push({
      id: o.opening_code,
      elev: "s" + hit.edge,
      floor: "Ground",
      room: o.label?.trim() || "Page " + o.page_number,
      type: styleText || "Window",
      w: wMm,
      h: hMm,
      x: hit.t * edgeLen[hit.edge],
      y: sill,
      lights,
      open,
      status: o.status === "installed" ? "installed" : "tofit",
      door: door || undefined,
      hand: spec?.operation ?? undefined,
      glass: spec?.glass ?? undefined,
      frame: spec?.color ?? undefined,
      assigned: o.assignee?.display_name ? [o.assignee.display_name] : undefined,
    });
  }

  return {
    id: input.projectId,
    ref: input.projectName,
    addr: input.projectAddress ?? "",
    rev: 1,
    building: {
      width: spanX * scale,
      depth: spanZ * scale,
      height: wallH,
      rise: 0,
      footprints: [footprint],
    },
    windows,
  };
}
