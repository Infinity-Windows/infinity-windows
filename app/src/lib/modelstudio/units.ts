// The Studio's unit catalog: company-wide window/door configurations built
// panel-by-panel in the wizard, or drafted from a job's window schedule.
// Pure data + drawing here; the wizard UI lives in components/studio.

import { supabase } from "../supabase";
import { isMissingTable } from "../schemaErrors";
import type { ProjectMarkSpec } from "../install/specs";

export type UnitKind = "window" | "door";
export type Mechanism = "fixed" | "slider" | "bifold" | "casement" | "hung";
export type SlideDirection = "left" | "right";

export interface UnitPanel {
  widthMm: number;
  mechanism: Mechanism;
  /** Which way a moving panel slides/folds. Meaningless for fixed/hung. */
  direction?: SlideDirection;
}

export interface UnitConfig {
  kind: UnitKind;
  heightMm: number;
  panels: UnitPanel[];
}

export interface StudioUnit {
  id: string;
  name: string;
  kind: UnitKind;
  config: UnitConfig;
  source: "built" | "spec-import";
  is_active: boolean;
}

export const MECHANISM_LABELS: Record<Mechanism, string> = {
  fixed: "Fixed",
  slider: "Slider",
  bifold: "Bi-fold",
  casement: "Casement",
  hung: "Single-hung",
};

const IN_TO_MM = 25.4;

export function unitWidthMm(c: UnitConfig): number {
  return c.panels.reduce((t, p) => t + p.widthMm, 0);
}

// ---------------------------------------------------------------- catalog IO

export async function listStudioUnits(): Promise<StudioUnit[]> {
  const { data, error } = await supabase
    .from("studio_units")
    .select("*")
    .eq("is_active", true)
    .order("kind")
    .order("name");
  if (error) {
    if (isMissingTable(error, "studio_units")) return [];
    throw error;
  }
  return (data ?? []) as StudioUnit[];
}

export async function saveStudioUnit(
  name: string,
  config: UnitConfig,
  source: "built" | "spec-import" = "built",
): Promise<StudioUnit> {
  const { data, error } = await supabase
    .from("studio_units")
    .insert({ name, kind: config.kind, config, source })
    .select("*")
    .single();
  if (error) throw error;
  return data as StudioUnit;
}

export async function retireStudioUnit(id: string): Promise<void> {
  const { error } = await supabase
    .from("studio_units")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

// ------------------------------------------------------------- spec import

/**
 * Draft a unit config from a job-schedule spec row. Operation strings map
 * to panel layouts the trade way: viewed from outside, X = operable, O =
 * fixed — "XO" is a two-panel slider with the left panel moving.
 */
export function specToUnitConfig(spec: ProjectMarkSpec): UnitConfig | null {
  const w = spec.width_in != null ? spec.width_in * IN_TO_MM : null;
  const h = spec.height_in != null ? spec.height_in * IN_TO_MM : null;
  if (!w || !h || w < 200 || h < 200) return null;
  const op = (spec.operation ?? "").trim().toUpperCase();
  const style = (spec.style ?? "").toLowerCase();
  const isDoor = /door|slider door|patio/.test(style);
  const kind: UnitKind = isDoor ? "door" : "window";

  const xo = op.match(/^[XO]{2,4}$/);
  let panels: UnitPanel[];
  if (xo) {
    const letters = op.split("");
    const pw = w / letters.length;
    panels = letters.map((ch, i) => ({
      widthMm: pw,
      mechanism: ch === "X" ? "slider" : "fixed",
      // A moving panel slides toward its nearest fixed neighbour.
      direction: ch === "X" ? (i === 0 ? "right" : "left") : undefined,
    })) as UnitPanel[];
  } else if (/CASEMENT/.test(op)) {
    panels = [{ widthMm: w, mechanism: "casement", direction: "left" }];
  } else if (/HUNG|SH|DH/.test(op)) {
    panels = [{ widthMm: w, mechanism: "hung" }];
  } else {
    panels = [{ widthMm: w, mechanism: "fixed" }];
  }
  return { kind, heightMm: h, panels };
}

export function specImportName(spec: ProjectMarkSpec): string {
  const op = spec.operation ?? "Fixed";
  const wIn = spec.width_in != null ? Math.round(spec.width_in) : "?";
  const hIn = spec.height_in != null ? Math.round(spec.height_in) : "?";
  return `${op} ${wIn}×${hIn}"`;
}

// ------------------------------------------------------------- SVG drawing

/**
 * Front-elevation drawing of a unit, trade-symbol style: sliders get
 * direction arrows, bi-folds a zig-zag, casements the hinge "V", hung an
 * up-arrow, fixed panels stay plain. Returns an SVG string sized to fit a
 * given box while keeping the unit's true aspect.
 */
export function unitSvg(c: UnitConfig, boxW = 220, boxH = 140): string {
  const w = unitWidthMm(c);
  const h = c.heightMm;
  const scale = Math.min((boxW - 8) / w, (boxH - 8) / h);
  const W = w * scale;
  const H = h * scale;
  const x0 = (boxW - W) / 2;
  const y0 = (boxH - H) / 2;
  const parts: string[] = [];
  const stroke = "currentColor";
  parts.push(
    `<rect x="${x0}" y="${y0}" width="${W}" height="${H}" fill="none" stroke="${stroke}" stroke-width="2.5"/>`,
  );
  let px = x0;
  for (const p of c.panels) {
    const pw = p.widthMm * scale;
    parts.push(
      `<rect x="${px}" y="${y0}" width="${pw}" height="${H}" fill="none" stroke="${stroke}" stroke-width="1.2"/>`,
    );
    const cx = px + pw / 2;
    const cy = y0 + H / 2;
    const a = Math.min(pw, H) * 0.28;
    if (p.mechanism === "slider") {
      const dir = p.direction === "left" ? -1 : 1;
      parts.push(
        `<line x1="${cx - a * dir}" y1="${cy}" x2="${cx + a * dir}" y2="${cy}" stroke="${stroke}" stroke-width="2"/>`,
        `<path d="M ${cx + a * dir} ${cy} l ${-6 * dir} -4 v 8 z" fill="${stroke}"/>`,
      );
    } else if (p.mechanism === "bifold") {
      const dir = p.direction === "left" ? -1 : 1;
      parts.push(
        `<polyline points="${px + pw * 0.15},${y0 + H * 0.8} ${cx},${y0 + H * 0.55} ${px + pw * 0.85},${y0 + H * 0.8}" fill="none" stroke="${stroke}" stroke-width="1.6"/>`,
        `<path d="M ${cx + a * 0.9 * dir} ${cy - H * 0.18} l ${-6 * dir} -4 v 8 z" fill="${stroke}"/>`,
      );
    } else if (p.mechanism === "casement") {
      const hx = p.direction === "left" ? px : px + pw;
      const fx = p.direction === "left" ? px + pw : px;
      parts.push(
        `<polyline points="${fx},${y0} ${hx},${cy} ${fx},${y0 + H}" fill="none" stroke="${stroke}" stroke-width="1.3" stroke-dasharray="4 3"/>`,
      );
    } else if (p.mechanism === "hung") {
      parts.push(
        `<line x1="${cx}" y1="${cy + a}" x2="${cx}" y2="${cy - a}" stroke="${stroke}" stroke-width="2"/>`,
        `<path d="M ${cx} ${cy - a} l -4 6 h 8 z" fill="${stroke}"/>`,
        `<line x1="${px}" y1="${cy}" x2="${px + pw}" y2="${cy}" stroke="${stroke}" stroke-width="1.2"/>`,
      );
    }
    px += pw;
  }
  return `<svg viewBox="0 0 ${boxW} ${boxH}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
}
