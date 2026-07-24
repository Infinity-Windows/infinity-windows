// Pure, unit-tested helpers for rich per-mark window/door line-item specs.
//
// Specs are captured PER MARK (e.g. mark "1") from the specs planset and shared
// across every instance/opening of that mark (1-1, 1-2, …). Nothing here talks
// to the network or the DB — the decoder, normalizer, and merge are pure so
// they can be unit-tested and reused on the client and (conceptually) the edge.

import { markBase } from "./extract";

/**
 * The full manufacturer line-item spec for a single mark. Every field is
 * best-effort / nullable — a specs planset rarely lists all of them, and the
 * review step lets a foreman correct or fill anything the extractor missed.
 */
export interface MarkSpec {
  /** Base mark this spec belongs to (e.g. "1", "W3", "A-101"). */
  mark_code: string;
  /** e.g. "Thermal Break Aluminum Fixed Window (Nail Fins)". */
  style: string | null;
  /** e.g. "5 (Low-E 366)+12A+5 (Low-E 366) Insulating tempered … (argon)". */
  glass: string | null;
  /** e.g. "Black (Aluminum Profile Color)". */
  color: string | null;
  /** Raw manufacturer call size, e.g. "3060". Kept verbatim. */
  size_code: string | null;
  /** Decoded width in inches (from size_code) — null when it can't decode. */
  width_in: number | null;
  /** Decoded height in inches (from size_code) — null when it can't decode. */
  height_in: number | null;
  /** e.g. "XO", "OX", "Fixed", "Casement". */
  operation: string | null;
  tempered: boolean | null;
  egress: boolean | null;
  u_factor: number | null;
  shgc: number | null;
  grids: string | null;
  screen: string | null;
  /** Product line / manufacturer, e.g. "Andersen 100 Series". */
  product_line: string | null;
  /** Flexible catch-all for any other line-item attributes found. */
  extra: Record<string, unknown> | null;
  /** A foreman has reviewed + trusted this spec. */
  confirmed: boolean;
  /** How the spec was captured. */
  source: SpecSource;
}

export type SpecSource = "ai" | "manual" | "deterministic";

/** The subset of {@link MarkSpec} an extractor/review produces (no confirm). */
export type MarkSpecDraft = Omit<MarkSpec, "confirmed">;

/** A persisted `project_mark_specs` row (spec + identity/meta). */
export interface ProjectMarkSpec extends MarkSpec {
  id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * Coerce a raw DB row (or any loose object with identity fields) into a typed
 * {@link ProjectMarkSpec}. Reuses {@link normalizeSpec} so numeric strings from
 * PostgREST and a jsonb `extra` are cleaned consistently. Returns null only
 * when the row has no usable mark.
 */
export function parseSpecRow(row: unknown): ProjectMarkSpec | null {
  if (!row || typeof row !== "object") return null;
  const o = row as Record<string, unknown>;
  const base = normalizeSpec(o, (o.source as SpecSource) ?? "ai");
  if (!base) return null;
  return {
    ...base,
    confirmed: Boolean(o.confirmed),
    id: String(o.id ?? ""),
    project_id: String(o.project_id ?? ""),
    created_at: String(o.created_at ?? ""),
    updated_at: String(o.updated_at ?? ""),
  };
}

export interface DecodedSize {
  widthIn: number;
  heightIn: number;
}

/**
 * Decode a WWHH manufacturer call size into width/height inches.
 *
 * The code is exactly four digits; each two-digit pair is (feet, inches):
 *   "3060" → width 3'0" (36"), height 6'0" (72")
 *   "2846" → width 2'8" (32"), height 4'6" (54")
 *   "6080" → width 6'0" (72"), height 8'0" (96")
 *
 * Anything that doesn't cleanly decode returns null and is left for the review
 * step to catch: non-4-digit codes, non-numeric codes, or an inch digit that
 * lands outside 0–11 (the "2-digit inch part" oddity). PURE — no side effects.
 */
export function decodeSizeCode(raw: string | null | undefined): DecodedSize | null {
  if (raw == null) return null;
  const code = String(raw).trim();
  // Must be exactly four digits — reject "306", "30600", "3'0x6'0", "30x60".
  if (!/^\d{4}$/.test(code)) return null;

  const widthFeet = Number(code[0]);
  const widthInch = Number(code[1]);
  const heightFeet = Number(code[2]);
  const heightInch = Number(code[3]);

  // Each pair's inch digit must be a valid inches value (0–11). A single digit
  // can never exceed 9, but keep the guard explicit so the intent is clear and
  // future 2-digit-inch inputs are rejected rather than silently mis-decoded.
  if (widthInch > 11 || heightInch > 11) return null;

  return {
    widthIn: widthFeet * 12 + widthInch,
    heightIn: heightFeet * 12 + heightInch,
  };
}

/** Format total inches as feet-inches, e.g. 36 → `3'0"`. */
export function formatFeetInches(totalInches: number | null | undefined): string | null {
  if (totalInches == null || !Number.isFinite(totalInches) || totalInches < 0) {
    return null;
  }
  const whole = Math.round(totalInches);
  const feet = Math.floor(whole / 12);
  const inches = whole % 12;
  return `${feet}'${inches}"`;
}

/**
 * Human-friendly size string for display: `3'0" × 6'0" (36" × 72")`.
 * Prefers the decoded width/height; falls back to just the total inches, or to
 * the raw size code, and returns null when there's nothing to show.
 */
export function formatSize(
  spec: Pick<MarkSpec, "width_in" | "height_in" | "size_code">,
): string | null {
  const { width_in, height_in, size_code } = spec;
  if (width_in != null && height_in != null) {
    const wf = formatFeetInches(width_in);
    const hf = formatFeetInches(height_in);
    const feetPart = wf && hf ? `${wf} × ${hf}` : null;
    const inchPart = `${Math.round(width_in)}" × ${Math.round(height_in)}"`;
    return feetPart ? `${feetPart} (${inchPart})` : inchPart;
  }
  if (size_code && size_code.trim()) return size_code.trim();
  return null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Coerce a loose boolean-ish value (from JSON, an AI response, or a checkbox)
 * to a strict boolean, or null when absent/unknown. "yes"/"true"/"tempered"
 * style strings count as true; "no"/"false"/"none" as false.
 */
function bool(v: unknown): boolean | null {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["true", "yes", "y", "1", "tempered", "egress"].includes(s)) return true;
  if (["false", "no", "n", "0", "none", "n/a", "na"].includes(s)) return false;
  return null;
}

/** Extract a size code from either an explicit field or a free-text string. */
export function findSizeCode(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  if (/^\d{4}$/.test(s)) return s;
  const m = s.match(/\b(\d{4})\b/);
  return m ? m[1] : null;
}

/**
 * Normalize an arbitrary object (AI output, DB row, or edited form values) into
 * a clean {@link MarkSpecDraft}. Never throws: bad/missing fields degrade to
 * null. Returns null only when there's no usable mark to key on.
 *
 * When width/height aren't supplied but the size code decodes, they're filled
 * from the decode so the stored row always has the derived dimensions.
 */
export function normalizeSpec(
  raw: unknown,
  fallbackSource: SpecSource = "ai",
): MarkSpecDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const markRaw =
    str(o.mark_code) ?? str(o.mark) ?? str(o.markCode) ?? str(o.openingCode);
  if (!markRaw) return null;
  const mark = markBase(markRaw);
  if (!mark) return null;

  // An explicit size_code field is kept verbatim (even if it can't decode — the
  // review step catches oddballs). Only a free-text `size` is scanned for a
  // 4-digit call size.
  const sizeCode =
    str(o.size_code) ?? str(o.sizeCode) ?? findSizeCode(o.size);

  let widthIn = num(o.width_in) ?? num(o.widthIn);
  let heightIn = num(o.height_in) ?? num(o.heightIn);
  const decoded = decodeSizeCode(sizeCode);
  if (decoded) {
    widthIn ??= decoded.widthIn;
    heightIn ??= decoded.heightIn;
  }

  const source = ((): SpecSource => {
    const s = str(o.source)?.toLowerCase();
    if (s === "ai" || s === "manual" || s === "deterministic") return s;
    return fallbackSource;
  })();

  const extraRaw = o.extra;
  const extra =
    extraRaw && typeof extraRaw === "object" && !Array.isArray(extraRaw)
      ? (extraRaw as Record<string, unknown>)
      : null;

  return {
    mark_code: mark,
    style: str(o.style) ?? str(o.type) ?? str(o.description),
    glass: str(o.glass) ?? str(o.glazing),
    color: str(o.color) ?? str(o.colour) ?? str(o.finish),
    size_code: sizeCode,
    width_in: widthIn,
    height_in: heightIn,
    operation: str(o.operation) ?? str(o.operating) ?? str(o.config),
    tempered: bool(o.tempered),
    egress: bool(o.egress),
    u_factor: num(o.u_factor) ?? num(o.uFactor) ?? num(o.u),
    shgc: num(o.shgc) ?? num(o.SHGC),
    grids: str(o.grids) ?? str(o.grille) ?? str(o.grilles),
    screen: str(o.screen) ?? str(o.screens),
    product_line:
      str(o.product_line) ??
      str(o.productLine) ??
      str(o.manufacturer) ??
      str(o.brand) ??
      str(o.series),
    extra: extra && Object.keys(extra).length > 0 ? extra : null,
    source,
  };
}

/** True when a normalized draft carries at least one meaningful spec field. */
export function hasAnySpec(spec: MarkSpecDraft): boolean {
  return Boolean(
    spec.style ||
      spec.glass ||
      spec.color ||
      spec.size_code ||
      spec.width_in != null ||
      spec.height_in != null ||
      spec.operation ||
      spec.tempered != null ||
      spec.egress != null ||
      spec.u_factor != null ||
      spec.shgc != null ||
      spec.grids ||
      spec.screen ||
      spec.product_line ||
      (spec.extra && Object.keys(spec.extra).length > 0),
  );
}

/**
 * Normalize + merge a list of raw spec objects, keyed by base mark. When two
 * entries share a mark, later non-null fields fill earlier gaps (they reinforce
 * rather than clobber). Entries with no usable mark or no spec data are
 * dropped. Result is sorted by mark for stable display.
 */
export function mergeSpecsByMark(
  raws: unknown[],
  fallbackSource: SpecSource = "ai",
): MarkSpecDraft[] {
  const byMark = new Map<string, MarkSpecDraft>();
  for (const raw of raws) {
    const spec = normalizeSpec(raw, fallbackSource);
    if (!spec || !hasAnySpec(spec)) continue;
    const key = spec.mark_code.toUpperCase();
    const existing = byMark.get(key);
    if (!existing) {
      byMark.set(key, spec);
      continue;
    }
    byMark.set(key, fillGaps(existing, spec));
  }
  return [...byMark.values()].sort((a, b) =>
    a.mark_code.localeCompare(b.mark_code, undefined, { numeric: true }),
  );
}

/** Index specs by their (upper-cased) base mark for O(1) opening lookups. */
export function indexSpecsByMark<T extends { mark_code: string }>(
  specs: T[],
): Map<string, T> {
  const m = new Map<string, T>();
  for (const s of specs) m.set(s.mark_code.toUpperCase(), s);
  return m;
}

/** Resolve an opening code (e.g. "1-2") to its mark spec via markBase("1"). */
export function specForOpeningCode<T extends { mark_code: string }>(
  index: Map<string, T>,
  openingCode: string | null | undefined,
): T | null {
  if (!openingCode) return null;
  return index.get(markBase(openingCode).toUpperCase()) ?? null;
}

/** Fill null fields of `base` from `next` without overwriting existing values. */
function fillGaps(base: MarkSpecDraft, next: MarkSpecDraft): MarkSpecDraft {
  const merged: MarkSpecDraft = { ...base };
  const keys: (keyof MarkSpecDraft)[] = [
    "style",
    "glass",
    "color",
    "size_code",
    "width_in",
    "height_in",
    "operation",
    "tempered",
    "egress",
    "u_factor",
    "shgc",
    "grids",
    "screen",
    "product_line",
  ];
  for (const k of keys) {
    if (merged[k] == null && next[k] != null) {
      // Field types are heterogeneous; the null-guard above keeps this safe.
      (merged as Record<string, unknown>)[k] = next[k];
    }
  }
  if (base.extra || next.extra) {
    merged.extra = { ...(next.extra ?? {}), ...(base.extra ?? {}) };
    if (Object.keys(merged.extra).length === 0) merged.extra = null;
  }
  return merged;
}
