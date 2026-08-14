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
import { absoluteSill, envelopeHeight, storiesOf, stretchStoriesToFit } from "./stories";
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
  /**
   * Role-aware status color for the crew-facing view (glowFor): red =
   * assigned & waiting, yellow = installed & awaiting QC, green = QC passed,
   * "none" = the plain blue. Absent on jobs built without a view context —
   * the tracer and old fixtures keep the prototype's status colors.
   */
  glow?: FitViewGlow;
  /** Flashing frame (flashFor): "done" solid aqua, "needed" dashed. */
  flash?: "done" | "needed";
}

export type FitViewGlow = "red" | "yellow" | "green" | "none";

/**
 * Who is looking at the model. Drives two crew-facing conveniences the
 * TRACER must never get: mark ids re-spelled in the extraction dialect
 * ("1A" -> "1-1", the style on work orders), and the glow colors above.
 * The tracer keeps authored ids because its stored dots are keyed by them.
 */
export interface FitViewViewContext {
  /** The signed-in profile, for "my windows" scoping. */
  viewerId: string | null;
  /** Foreman+ sees every installer's state; installers see their own. */
  managerView: boolean;
  /** Opening ids whose qc_checks row says 'passed'. */
  qcPassedOpeningIds: Set<string>;
  /** Opening ids with a SUBMITTED flashing phase (photo on record). */
  flashedOpeningIds?: Set<string>;
}

/**
 * The flashing frame, a channel apart from the glow: solid aqua = flashing
 * submitted, dashed aqua = flashing still owed, nothing = never needed it.
 * "Done" wins even on a later-exempted opening — the work happened and the
 * photo exists. Universal for every role: envelope prep is crew-wide truth.
 */
export function flashFor(
  live: { id: string; needs_flashing?: boolean | null } | undefined,
  view: FitViewViewContext,
): "done" | "needed" | null {
  if (!live) return null;
  if (view.flashedOpeningIds?.has(live.id)) return "done";
  if (live.needs_flashing === true) return "needed";
  return null;
}

/**
 * The one color a window shows this viewer. Green (QC passed) is universal.
 * Yellow (installed) and red (assigned, waiting) are the viewer's own
 * windows unless they hold the manager view — another installer's workload
 * is not this installer's signal.
 */
export function glowFor(
  live: { id: string; status: string; assigned_to: string | null } | undefined,
  view: FitViewViewContext,
): FitViewGlow {
  if (!live) return "none";
  if (view.qcPassedOpeningIds.has(live.id)) return "green";
  const mine = view.viewerId !== null && live.assigned_to === view.viewerId;
  if (live.status === "installed") return view.managerView || mine ? "yellow" : "none";
  if (live.assigned_to) return view.managerView || mine ? "red" : "none";
  return "none";
}

/**
 * Re-spell a survey mark in the extraction dialect the crew's work orders
 * use: "1A" -> "1-1", "13B" -> "13-2". Typical-floor clone suffixes ride
 * along ("201A@L3" -> "201-1@L3"); anything else passes through untouched.
 * Display only — normalizeMarkCode equates both spellings for matching.
 */
export function displayMarkCode(id: string): string {
  const m = /^(\d+)\s*([A-Za-z])(@L\d+)?$/.exec(id.trim());
  if (!m) return id;
  const twin = m[2].toUpperCase().charCodeAt(0) - 64;
  return `${m[1]}-${twin}${m[3] ?? ""}`;
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
  /** Present when the spec-driven auto-scale grew an uncalibrated building
   * so its windows fit — surfaced so the Studio can say so. */
  autoScale?: { factor: number; longSideM: number };
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
    /** Storied models (stories.ts shape); absent = one story of the above. */
    stories?: unknown;
    /** Raw tracer state for re-editing; opaque to the adapter. */
    trace?: unknown;
  };
  /** Renderer-native windows; extra fields (legs, wrap, panes…) pass through. */
  windows: Array<Record<string, unknown> & { id: string; status?: string }>;
}

/**
 * Which outline row should the 3D tab trust? A job can legitimately hold
 * more than one: the auto-extracted outline from planset processing AND a
 * saved survey model (they share a page, and the older one sorts first).
 * The row CARRYING a model always wins; the first row is only a fallback.
 */
export function preferModelOutline<T extends { features: unknown }>(
  rows: T[] | undefined,
): T | null {
  if (!rows || rows.length === 0) return null;
  return rows.find((r) => fitviewModel(r.features) !== null) ?? rows[0];
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
  // Typical-floor clones ("12@L3") resolve to their source mark: live
  // status, deep links and dedup all flow through the one real opening.
  const t = code.trim().toUpperCase().replace(/@L\d+$/, "");
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
  view?: FitViewViewContext,
): FitViewJob {
  const liveByCode = new Map<string, ProjectOpening>();
  for (const o of openings) liveByCode.set(normalizeMarkCode(o.opening_code), o);

  // Storied models keep sills relative to their own floor (edits stay local);
  // the renderer positions in absolute height, so the conversion happens
  // here, at the boundary, and nowhere else.
  //
  // The same boundary defends against impossible heights: a story shorter
  // than its own tallest glass (saved before heights auto-fit, or hand-set
  // too low) is stretched to fit, and the stories above ride up with it.
  const canonical = storiesOf(model.building);
  const stories = stretchStoriesToFit(
    canonical,
    model.windows as { story?: unknown; y?: unknown; h?: unknown }[],
  );
  const grew = stories.some(
    (s, i) => s.heightM !== canonical[i].heightM || s.elevM !== canonical[i].elevM,
  );
  const building = !grew
    ? model.building
    : Array.isArray(model.building.stories)
      ? { ...model.building, stories, height: envelopeHeight(stories) }
      : { ...model.building, height: stories[0].heightM };

  const windows = model.windows.map((raw) => {
    const w = { ...raw, y: absoluteSill(raw as { y?: unknown; story?: unknown }, stories) };
    // Crew-facing view: work-order spelling for the id. The tracer path
    // (no view) keeps authored ids — its stored dots are keyed by them.
    if (view) w.id = displayMarkCode(String(raw.id));
    const live = liveByCode.get(normalizeMarkCode(String(w.id)));
    if (view) {
      (w as { glow?: FitViewGlow }).glow = glowFor(live, view);
      const flash = flashFor(live, view);
      if (flash) (w as { flash?: string }).flash = flash;
    }
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
    building,
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

/** Frames/mullions take room beyond the glass — packing headroom. */
const SCALE_PACK = 1.15;
/** Never auto-scale past 4× (a mis-pinned window on a short wall would
 * otherwise inflate the whole building). */
const SCALE_CAP = 4;

/**
 * PURE: how much an uncalibrated building must grow so that no wall's
 * windows (true mm widths) overflow it. 1 = the default scale already fits.
 */
export function specDrivenScaleFactor(
  demands: { edge: number; wMm: number }[],
  pageEdgeLen: number[],
  baseScale: number,
  cap = SCALE_CAP,
): number {
  const perEdge = new Map<number, number>();
  for (const d of demands) {
    perEdge.set(d.edge, (perEdge.get(d.edge) ?? 0) + d.wMm / 1000);
  }
  let factor = 1;
  for (const [edge, totalM] of perEdge) {
    const lenM = (pageEdgeLen[edge] ?? 0) * baseScale;
    if (!(lenM > 0)) continue;
    factor = Math.max(factor, (totalM * SCALE_PACK) / lenM);
  }
  return Math.min(cap, factor);
}

/**
 * Build the fit-view job, or null when the outline can't support one.
 * Only openings pinned on the outline's page are placed on the model.
 */
export function buildFitViewJob(
  input: AdapterInput,
  view?: FitViewViewContext,
): FitViewJob | null {
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

  const baseScale = (input.longSideM ?? DEFAULT_LONG_SIDE_M) / span;
  const wallH = input.wallHeightM ?? DEFAULT_WALL_HEIGHT_M;

  // Page-space edge lengths (scale-independent).
  const pageEdgeLen: number[] = phys.map((a, i) => {
    const b = phys[(i + 1) % phys.length];
    return Math.hypot(b.x - a.x, b.z - a.z);
  });

  const specByMark = new Map<string, ProjectMarkSpec>();
  for (const s of input.specs) specByMark.set(s.mark_code, s);

  // First pass: resolve every placeable opening's wall + true mm size, so
  // the spec-driven scale check can run BEFORE geometry is built.
  interface Placement {
    o: (typeof input.openings)[number];
    hit: { edge: number; t: number };
    spec: ProjectMarkSpec | null;
    wMm: number;
    hMm: number;
  }
  const placements: Placement[] = [];
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
    placements.push({
      o,
      hit,
      spec,
      wMm: wIn != null ? Math.round(wIn * IN_TO_MM) : FALLBACK_W_MM,
      hMm: hIn != null ? Math.round(hIn * IN_TO_MM) : FALLBACK_H_MM,
    });
  }

  // Windows are TRUE size (mm from specs) while an uncalibrated building is
  // a 30 m guess — the mismatch put windows wider than their walls (owner
  // screenshot). When no explicit calibration exists, scale the building up
  // until no wall's windows overflow it. A tracer calibration always wins.
  const factor =
    input.longSideM != null
      ? 1
      : specDrivenScaleFactor(
          placements.map((p) => ({ edge: p.hit.edge, wMm: p.wMm })),
          pageEdgeLen,
          baseScale,
        );
  const scale = baseScale * factor;
  const footprint = phys.map((p) => ({ x: p.x * scale, z: p.z * scale }));

  // Wall lengths in metres, matching elevationsOf()'s edge enumeration.
  const edgeLen: number[] = footprint.map((a, i) => {
    const b = footprint[(i + 1) % footprint.length];
    return Math.hypot(b.x - a.x, b.z - a.z);
  });

  const windows: FitViewWindow[] = [];
  for (const { o, hit, spec, wMm, hMm } of placements) {
    const type = o.window_types ?? null;
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
      glow: view ? glowFor(o, view) : undefined,
      flash: view ? flashFor(o, view) ?? undefined : undefined,
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
    autoScale:
      factor > 1.001
        ? {
            factor: Math.round(factor * 100) / 100,
            longSideM: Math.round(span * scale * 10) / 10,
          }
        : undefined,
  };
}
