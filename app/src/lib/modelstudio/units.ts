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

/**
 * The two fields a corner split needs — a structural subset both
 * UnitConfig and UnitTier satisfy, so `cornerLegs`/`cornerGeometryInfo`
 * apply the SAME rule whether they're reading the whole flat unit or one
 * tier of a multi-tier one, with no cast at either call site.
 */
export interface CornerSource {
  panels: UnitPanel[];
  cornerAfterPanel?: number | null;
}

/**
 * One TIER (CONTEXT.md): a horizontal row of panels within a unit, at
 * one story. A 9-pane storefront across three floors is one unit with
 * three tiers of three panels — Studio 100x #22.
 *
 * `story` is AUTHORED on the unit, not read off any real opening — it
 * anchors tier order before a catalog unit is ever tied to a job. The
 * base tier (index 0) conventionally starts at 1, same "ground level is
 * story 1" convention CONTEXT.md uses everywhere; `computeSignature`
 * (signature.ts) turns each tier's authored story into its REAL story by
 * adding the resolved opening's own base story — base story + offset,
 * where offset is this tier's authored story minus the base tier's.
 *
 * No `rows` here: a tier above the base has no pane-grid UI yet (the
 * wizard's existing controls don't offer one), so it's always a single
 * full-height row of panels in v1 — the same "absent rows = one row"
 * default `rowHeightsCm` already applies to a flat unit.
 */
export interface UnitTier extends CornerSource {
  heightMm: number;
  story?: number | null;
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
  /**
   * Frame (and glass tint) color, per unit — Studio 100x #47. Absent/"white"
   * are the same thing: unitGeometry's default IS today's exact hardcoded
   * hex, so every unit built before this field existed renders unchanged.
   */
  frameColor?: "white" | "bronze" | "black";
  /**
   * Tiers ABOVE and including the base — Studio 100x #22. Absent/empty =
   * today's flat shape IS the single tier: every config ever saved reads
   * exactly as it always has, unchanged, forever (most units never use
   * "+ Tier above").
   *
   * When present, index 0 is the BASE tier, and it's ALWAYS mirrored onto
   * this UnitConfig's own `panels`/`heightMm`/`cornerAfterPanel` above —
   * same mirroring philosophy as floors.ts's `serialized` mirroring
   * `floors[0]`: an OLD reader that only knows the flat shape (unitSvg,
   * unitAnnotations, roMismatch, the docked in-canvas pane-grid palette,
   * the sill/height drag handles) still sees a correct base tier and
   * keeps working completely unchanged. `configFromTiers` below is the
   * one place that writes `tiers` and keeps that mirror honest — building
   * this object any other way (hand-editing `tiers` directly, or an old
   * writer that only touches the flat fields) can desync the two; reading
   * always goes through `unitTiers`, never `config.tiers` directly, for
   * exactly that reason.
   */
  tiers?: UnitTier[] | null;
}

/**
 * Every tier of a unit, base first. The ONE place "does this config have
 * real tiers, or is the flat shape the whole story" gets decided — absent
 * or empty `tiers` synthesizes a single tier off the flat fields, so a
 * config that never sets it (the overwhelming majority, forever) is
 * indistinguishable from a config with one authored tier. Every reader
 * that needs to see EVERY panel of a unit — computeSignature,
 * buildUnitGeometry, panelFormula.ts's per-panel walk — goes through
 * this, never `config.panels` alone, or it would silently miss every
 * tier above the base.
 */
export function unitTiers(c: UnitConfig): UnitTier[] {
  if (c.tiers && c.tiers.length > 0) return c.tiers;
  return [
    { panels: c.panels, heightMm: c.heightMm, cornerAfterPanel: c.cornerAfterPanel, story: 1 },
  ];
}

/**
 * Build a UnitConfig from an ordered tier list (base first) — the write
 * side of the mirror `unitTiers` reads back. A single tier collapses to
 * today's plain flat shape: no `tiers` key at all (not even `null`), so a
 * unit that never used "+ Tier above" is byte-for-byte what it always
 * was. Two or more tiers set `tiers` AND mirror tier 0 onto the flat
 * fields, so any old reader that only knows the flat shape still sees
 * the base tier correctly.
 */
export function configFromTiers(
  common: Pick<UnitConfig, "kind" | "insetOutset" | "weightLb" | "frameColor">,
  tiers: readonly UnitTier[],
): UnitConfig {
  const base = tiers[0] ?? { panels: [], heightMm: 0, cornerAfterPanel: null, story: 1 };
  const flat: UnitConfig = {
    ...common,
    panels: base.panels,
    heightMm: base.heightMm,
    cornerAfterPanel: base.cornerAfterPanel ?? null,
  };
  // No `tiers` KEY at all below this line, not even `undefined` — a
  // single tier must reproduce today's plain flat shape exactly, and
  // `"tiers" in config` is how signature.ts's own #23 precedent (see
  // UnitConfig.insetOutset) already checks "does this field exist."
  return tiers.length > 1 ? { ...flat, tiers: [...tiers] } : flat;
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

/** Split a corner config into its two legs (outside view, left then right).
 * Takes a `CornerSource` (not the full `UnitConfig`) so the SAME rule
 * applies to a lone tier of a multi-tier unit — every existing caller
 * already passes a full UnitConfig, which satisfies it unchanged. */
export function cornerLegs(
  c: CornerSource,
): { left: UnitPanel[]; right: UnitPanel[] } | null {
  const k = c.cornerAfterPanel;
  if (k == null || k < 0 || k >= c.panels.length - 1) return null;
  return { left: c.panels.slice(0, k + 1), right: c.panels.slice(k + 1) };
}

/**
 * Studio 100x #13 — a constructability PREFLIGHT, run over a resolved
 * config instead of only clamping silently at edit/render time. The
 * builder's own controls (the corner picker, the slide ± buttons) can
 * never CREATE one of these findings — they clamp as the operator goes —
 * but a config can still arrive with one from OUTSIDE the builder: a
 * hand-edited catalog row, an older extraction, or a spec drawing that
 * asked for something the shop floor can't build.
 *
 * PURE, and reuses the EXACT rules the builder/geometry already enforce
 * (`cornerLegs`, `slideCountOf`) rather than inventing new ones — a finding
 * here can never disagree with what the Studio would actually build.
 * Never blocks anything; callers show these as plain warning text only.
 */
export function constructabilityProblems(config: UnitConfig): string[] {
  const problems: string[] = [];

  // A corner was asked for, but cornerLegs (the SAME split the geometry and
  // annotation layout both call) says it isn't a legal one — it silently
  // renders flat instead of the corner the config claims.
  if (config.cornerAfterPanel != null && cornerLegs(config) == null) {
    const n = config.panels.length;
    problems.push(
      `the corner after panel ${config.cornerAfterPanel + 1} isn't a legal split for ${n} panel${n === 1 ? "" : "s"}`,
    );
  }

  // A slider's stored slide count needed clamping to land in the buildable
  // 1–8 range — slideCountOf already clamps it for rendering, so this is
  // never visibly broken, but the STORED number promises something the
  // shop floor can't build (or a spec drawing that lied about the count).
  config.panels.forEach((p, i) => {
    if (p.mechanism !== "slider" || p.slideCount == null) return;
    if (slideCountOf(p) !== p.slideCount) {
      problems.push(
        `panel ${i + 1}'s slide count (${p.slideCount}) is outside the buildable 1-8 range`,
      );
    }
  });

  return problems;
}

export function panelsWidthMm(panels: UnitPanel[]): number {
  return panels.reduce((t, p) => t + p.widthMm, 0);
}

/**
 * Mirror a unit's operable directions (Studio 100x #38's "Mirror" duplicate
 * action): every panel that opens left now opens right and vice-versa.
 * Sliders, bi-folds and casements all carry `direction`; fixed/hung panels
 * have none and pass through untouched. A pure data flip only — panel order,
 * widths, mechanisms and any corner stay exactly as they were, so this is
 * safe to apply to any config without re-deriving geometry.
 */
export function mirrorUnitConfig(c: UnitConfig): UnitConfig {
  const flip = (panels: UnitPanel[]): UnitPanel[] =>
    panels.map((p) =>
      p.direction
        ? { ...p, direction: p.direction === "left" ? "right" : "left" }
        : { ...p },
    );
  return {
    ...c,
    panels: flip(c.panels),
    // Tiers mirror on their OWN panels too, not just the flat fields —
    // every reader past the base tier reads `tiers` (unitTiers), so a
    // mirror that only flipped the flat mirror would leave a multi-tier
    // unit inconsistent with itself: tier 1 flipped, tiers above it not.
    ...(c.tiers ? { tiers: c.tiers.map((t) => ({ ...t, panels: flip(t.panels) })) } : {}),
  };
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
 * Map a spec's free-text color/finish (e.g. "Black (Aluminum Profile
 * Color)") onto the Studio's constrained frame-color choices (#47). Only a
 * confident keyword match sets a value — a blank field, "white", or an
 * unrecognized finish name all leave `frameColor` unset, which
 * unitGeometry already renders as white (today's default). Better to say
 * nothing than to guess wrong from a manufacturer's finish name.
 */
function frameColorFromSpecColor(color: string | null): UnitConfig["frameColor"] {
  const c = (color ?? "").toLowerCase();
  if (c.includes("black")) return "black";
  if (c.includes("bronze")) return "bronze";
  return undefined;
}

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
  const frameColor = frameColorFromSpecColor(spec.color);

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
    return { kind, heightMm: h, panels, cornerAfterPanel, frameColor };
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
  return { kind, heightMm: h, panels, frameColor };
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
