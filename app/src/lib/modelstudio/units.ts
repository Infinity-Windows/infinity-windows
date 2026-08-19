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
  /**
   * How many panel-widths a SLIDING pane travels (owner, 2026-08-14: "i
   * should be able to select up to 8 times that a window can slide" —
   * multi-track stacks). 1–8; absent = 1, ignored off sliders.
   */
  slideCount?: number;
}

/** Clamp a panel's slide count into the buildable 1–8 range. */
export function slideCountOf(p: UnitPanel): number {
  if (p.mechanism !== "slider") return 1;
  const n = Math.round(p.slideCount ?? 1);
  return Math.min(8, Math.max(1, Number.isFinite(n) ? n : 1));
}

export interface UnitConfig {
  kind: UnitKind;
  heightMm: number;
  panels: UnitPanel[];
  /**
   * 0-based index of the last panel BEFORE a 90° turn — window 16's five
   * panels wrap a building corner after its first 30¼" panel, so
   * `cornerAfterPanel: 0`. Panels read left→right in the drawing's Outside
   * View on both legs. Absent/null = flat unit.
   */
  cornerAfterPanel?: number | null;
  /**
   * Horizontal breaks (owner ask 2026-08-13: split panes "like a grid").
   * Rows read TOP→BOTTOM in the outside view and share their mullion
   * lines with every column — typing one pane's height resizes its whole
   * row, the way real butt-glazed grids work. Row heights sum to
   * heightMm; absent = one full-height row.
   */
  rows?: { heightMm: number }[] | null;
  /**
   * Mounts inset or outset — a SIGNATURE field (CONTEXT.md). Spec-driven
   * units get this from the extractor via signatureSync's
   * `insetOutsetOf`; a hand-built catalog unit has no spec to read it
   * from, so the builder's 3-way control writes it here instead, and
   * `insetOutsetOf` prefers this value when it's set, spec.extra
   * otherwise (catalog beats spec, same priority the config itself
   * already gets). Absent/null is its own honest "not sure" — and it's
   * safe by construction: `computeSignature` never reads this field off
   * the config, only the already-resolved `UnitFacts.insetOutset` a
   * caller hands it, so a config that leaves this unset produces the
   * exact signature it always has (pinned in signature.test.ts).
   */
  insetOutset?: "inset" | "outset" | null;
  /**
   * Weight in pounds, off the Strata paperwork. DELIBERATE: stored on the
   * unit but never folded into SignatureV1. Weight is continuous — a
   * 40lb sash and a 45lb sash are the same "kind" of install — so
   * signing it would fracture every existing cohort key into
   * near-singletons for zero grouping benefit, exactly the mistake
   * dimensions already avoid (CONTEXT.md: "sizes are continuous
   * evidence"). It rides here in the jsonb config purely so the catalog
   * can show it back ("~180 lb"); no migration needed, no signature
   * version bump.
   */
  weightLb?: number | null;
}

/** Row heights top→bottom, cm — a missing/invalid grid is one full row. */
export function rowHeightsCm(c: UnitConfig): number[] {
  const rows = c.rows;
  if (!rows || rows.length === 0) return [c.heightMm / 10];
  const total = rows.reduce((t, r) => t + r.heightMm, 0);
  if (!(total > 0)) return [c.heightMm / 10];
  // Normalize drift so the grid always fills the unit exactly.
  const scale = c.heightMm / total;
  return rows.map((r) => (r.heightMm * scale) / 10);
}

// ------------------------------------------------------- pane grid editing
// Shared mullion lines (owner pick): a pane's width IS its column's width,
// its height IS its row's height — typing one resizes the whole line, the
// way real butt-glazed grids are built. All pure; the Studio applies them.

/** Set one column's width; the unit's total width follows. */
export function setColumnWidthMm(c: UnitConfig, col: number, widthMm: number): UnitConfig {
  return {
    ...c,
    panels: c.panels.map((p, i) => (i === col ? { ...p, widthMm } : p)),
  };
}

/** Set one row's height; the unit's total height follows (other rows keep
 * their real size — resizing pane R2 must not squash R1). */
export function setRowHeightMm(c: UnitConfig, row: number, heightMm: number): UnitConfig {
  const rows = (c.rows?.length ? c.rows : [{ heightMm: c.heightMm }]).map((r, i) =>
    i === row ? { heightMm } : { heightMm: r.heightMm },
  );
  const total = rows.reduce((t, r) => t + r.heightMm, 0);
  return { ...c, rows, heightMm: total };
}

/** Split a column into two equal halves (same mechanism). A corner at or
 * right of the split shifts one column down the row. */
export function splitColumn(c: UnitConfig, col: number): UnitConfig {
  const p = c.panels[col];
  if (!p) return c;
  const half = { ...p, widthMm: p.widthMm / 2 };
  const panels = [...c.panels.slice(0, col), half, { ...half }, ...c.panels.slice(col + 1)];
  const k = c.cornerAfterPanel;
  return {
    ...c,
    panels,
    cornerAfterPanel: k != null && k >= col ? k + 1 : k,
  };
}

/** Split a row into two equal halves. */
export function splitRow(c: UnitConfig, row: number): UnitConfig {
  const rows = c.rows?.length ? c.rows : [{ heightMm: c.heightMm }];
  const r = rows[row];
  if (!r) return c;
  const half = { heightMm: r.heightMm / 2 };
  return {
    ...c,
    rows: [...rows.slice(0, row), half, { ...half }, ...rows.slice(row + 1)],
  };
}

export type PanePresetKind = "middle-pair" | "french-pair";

/**
 * Preset PAIRS (owner, 2026-08-14: "on some windows they will start in the
 * middle and slide out... i need the option to have a casement hinge left
 * and right"). Applied to the selected pane and its right-hand neighbour
 * (outside view):
 *
 * - middle-pair: the two panels meet in the middle and slide APART — left
 *   panel opens left, right panel opens right.
 * - french-pair: French casements — hinged on their OUTER stiles, both
 *   free edges meeting in the middle.
 *
 * A single-panel unit is split in half first; a selection on the last
 * column pairs with the neighbour on its left instead.
 */
export function applyPanePreset(
  c: UnitConfig,
  col: number,
  kind: PanePresetKind,
): UnitConfig {
  const next = c.panels.length === 1 ? splitColumn(c, 0) : c;
  const left = Math.max(0, Math.min(col, next.panels.length - 2));
  const mechanism: Mechanism = kind === "middle-pair" ? "slider" : "casement";
  return {
    ...next,
    panels: next.panels.map((p, i) =>
      i === left
        ? { ...p, mechanism, direction: "left" as const }
        : i === left + 1
          ? { ...p, mechanism, direction: "right" as const }
          : p,
    ),
  };
}

/** Split a corner config into its two legs (outside view, left then right). */
export function cornerLegs(
  c: UnitConfig,
): { left: UnitPanel[]; right: UnitPanel[] } | null {
  const k = c.cornerAfterPanel;
  if (k == null || k < 0 || k >= c.panels.length - 1) return null;
  return { left: c.panels.slice(0, k + 1), right: c.panels.slice(k + 1) };
}

export function panelsWidthMm(panels: UnitPanel[]): number {
  return panels.reduce((t, p) => t + p.widthMm, 0);
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

/**
 * Rewrite a catalog unit in place — how a spec import gets refined to match
 * its drawing (window 16 arrives as one fixed panel because the spec row
 * only carries overall dims; the builder splits it into its five).
 */
export async function updateStudioUnit(
  id: string,
  name: string,
  config: UnitConfig,
): Promise<StudioUnit> {
  const { data, error } = await supabase
    .from("studio_units")
    .update({ name, kind: config.kind, config, updated_at: new Date().toISOString() })
    .eq("id", id)
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

  // The extractor's drawing read wins: EXACT per-panel widths (window 16's
  // 30¼ | 88½ | 90 | 87¾ | 17) + per-panel ops + the 90° corner, straight
  // off the elevation. Falls through to operation-string splitting when
  // the drawing only printed an overall width.
  const ex = spec.extra as {
    panels?: { width_in?: number | null; op?: string | null }[];
    corner?: { after_panel?: number; side?: "left" | "right" };
  } | null;
  const drawn = ex?.panels?.filter(
    (p): p is { width_in: number; op: string | null } =>
      typeof p?.width_in === "number" && p.width_in > 2,
  );
  if (drawn && drawn.length >= 2) {
    const panels: UnitPanel[] = drawn.map((p, i) => {
      const operable = p.op === "X";
      return {
        widthMm: p.width_in * IN_TO_MM,
        mechanism: operable ? "slider" : "fixed",
        direction: operable ? (i === 0 ? "right" : "left") : undefined,
      };
    });
    let cornerAfterPanel: number | null = null;
    const c = ex?.corner;
    if (c && Number.isInteger(c.after_panel)) {
      cornerAfterPanel = Math.min(
        Math.max(0, c.after_panel!),
        panels.length - 2,
      );
      if (cornerAfterPanel < 0) cornerAfterPanel = null;
    } else if (c?.side) {
      cornerAfterPanel = c.side === "left" ? 0 : panels.length - 2;
    }
    return { kind, heightMm: h, panels, cornerAfterPanel };
  }

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

/**
 * Spec imports are named by their MARK — "Window 16", "Door 3" — because
 * that is what the crew calls them (owner, 2026-08-13: "have the number of
 * the window"). The catalog is company-wide while marks are per-job, so the
 * job code rides along to keep two jobs' window 16s apart. The drawing
 * details live in the config, not the name.
 */
export function specImportName(spec: ProjectMarkSpec, jobCode?: string | null): string {
  const style = (spec.style ?? "").toLowerCase();
  const isDoor = /door|slider door|patio/.test(style);
  const base = `${isDoor ? "Door" : "Window"} ${spec.mark_code}`;
  return jobCode ? `${base} · ${jobCode}` : base;
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
  // Row break lines (grid support), shared across every column.
  const rowsMm = rowHeightsCm(c).map((v) => v * 10);
  if (rowsMm.length > 1) {
    let yMm = 0;
    for (let ri = 0; ri < rowsMm.length - 1; ri++) {
      yMm += rowsMm[ri];
      const ly = y0 + yMm * scale;
      parts.push(
        `<line x1="${x0}" y1="${ly}" x2="${x0 + W}" y2="${ly}" stroke="${stroke}" stroke-width="1.6"/>`,
      );
    }
  }
  // 90° corner marker at the split, drawn the way the spec sheet draws it:
  // an arc over the joint plus the label.
  const legs = cornerLegs(c);
  if (legs) {
    const splitX =
      x0 + (legs.left.reduce((t, p) => t + p.widthMm, 0) * scale);
    parts.push(
      `<path d="M ${splitX - 10} ${y0 - 2} A 10 10 0 0 1 ${splitX + 10} ${y0 - 2}" fill="none" stroke="${stroke}" stroke-width="1.4"/>`,
      `<line x1="${splitX}" y1="${y0}" x2="${splitX}" y2="${y0 + H}" stroke="${stroke}" stroke-width="2.6"/>`,
      `<text x="${splitX}" y="${Math.max(8, y0 - 4)}" text-anchor="middle" font-size="8" fill="${stroke}">90°</text>`,
    );
  }
  return `<svg viewBox="0 0 ${boxW} ${boxH}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
}
