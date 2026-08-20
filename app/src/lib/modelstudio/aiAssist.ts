// Model Studio's "🤖 Ask about this model" assistant (Studio 100x #42).
//
// THE DISCOVERY THIS BUILDS ON: the vendored blueprint3d-modern fork ships a
// fully built, tested, token-efficient model-to-text serializer
// (vendor/services/simplify-canvas-data.ts) that was wired to nothing —
// built for a Feng Shui feature that never shipped. This file is what wires
// it up: it turns the live Blueprint3d instance into the small JSON payload
// the assistant reads, and turns the assistant's reply back into something
// the Studio can act on.
//
// Everything here is pure EXCEPT serializeFloorForAI, which is the one
// function that has to touch a live `bp` — same convention as
// nearestWallPlacement/longestWallPlacement in ModelStudio.tsx, which are
// untested for the same reason. Even that one takes `bp` structurally (only
// `bp.model.exportSerialized()`), so a minimal fake stands in for the real
// vendored engine in tests.
//
// The prompt, size cap and reply parser live in
// supabase/functions/_shared/studioAssist.ts and are re-exported below
// unchanged — that module is imported by both this file and the
// `studio-assist` edge function, so the two can never drift out of sync
// (same pattern as _shared/knowledge.ts and _shared/spendGuard.ts).

import { supabase } from "../supabase";
import { formatApiError } from "../errors";
import { fmtFtIn } from "./dims";
import {
  simplifyCanvasData,
  toMinifiedJSON,
  type SimplifiedCanvasData,
  type StudioSavedFloorplan,
  type StudioSerializedItem,
} from "./core";
import { unitWidthMm, type UnitConfig, type UnitKind } from "./units";
import {
  checkModelSize,
  MAX_MODEL_JSON_BYTES,
  parseAddUnitProposal,
  type AddUnitProposal,
  type AddUnitProposalConfig,
  type ModelSizeCheck,
  type ParsedReply,
} from "../../../../supabase/functions/_shared/studioAssist.ts";

export { checkModelSize, MAX_MODEL_JSON_BYTES, parseAddUnitProposal };
export type { AddUnitProposal, AddUnitProposalConfig, ModelSizeCheck, ParsedReply };

// ---------------------------------------------------------------------------
// Payload assembly — pure given a plain {floorplan, items} snapshot, so it's
// testable with the exact fixture simplify-canvas-data.test.ts already uses.
// ---------------------------------------------------------------------------

/** Studio units carry their name (metadata.itemName) but not a
 * SerializedItem.description — simplifyCanvasData only ever looks at
 * description, so an AI-facing payload built without this backfill would
 * show every placed unit as an anonymous box. Never overwrites a
 * description that's already set. */
export function backfillItemDescriptions(
  items: StudioSerializedItem[],
): StudioSerializedItem[] {
  return items.map((item) => {
    if (item.description) return item;
    const itemName = (item.metadata as { itemName?: unknown } | undefined)?.itemName;
    if (typeof itemName === "string" && itemName.trim()) {
      return { ...item, description: itemName.trim() };
    }
    return item;
  });
}

export interface CatalogSummaryEntry {
  name: string;
  kind: UnitKind;
  panels: number;
  widthIn: number;
  heightIn: number;
}

const MM_TO_IN = 1 / 25.4;
/** Keeps the catalog block small and deterministic — a company's saved
 * catalog can run long, and the assistant only needs enough of it to know
 * what already exists, not the whole thing. */
const MAX_CATALOG_SUMMARY = 20;

/** A compact, factual summary of the saved unit catalog — name, kind, panel
 * count, rounded size — for the assistant's "Saved unit catalog" context. */
export function buildUnitCatalogSummary(
  units: Array<{ name: string; config: UnitConfig }>,
): CatalogSummaryEntry[] {
  return units.slice(0, MAX_CATALOG_SUMMARY).map((u) => ({
    name: u.name,
    kind: u.config.kind,
    panels: u.config.panels.length,
    widthIn: Math.round(unitWidthMm(u.config) * MM_TO_IN),
    heightIn: Math.round(u.config.heightMm * MM_TO_IN),
  }));
}

export interface StudioAssistPayload {
  model: SimplifiedCanvasData;
  /** toMinifiedJSON(model) — what the size cap is measured against and, on
   * the wire, exactly what the request body's `model` field serializes to. */
  modelJson: string;
  unitCatalogSummary: CatalogSummaryEntry[];
}

/** Turn a live-shaped {floorplan, items} snapshot + catalog into the request
 * payload — pure, so it takes exactly what simplifyCanvasData's own test
 * fixture already provides. serializeFloorForAI below is the only caller
 * that has to go get that snapshot from a live Blueprint3d. */
export function buildStudioAssistPayload(
  serialized: { floorplan: StudioSavedFloorplan; items: StudioSerializedItem[] },
  units: Array<{ name: string; config: UnitConfig }>,
): StudioAssistPayload {
  const model = simplifyCanvasData({
    floorplan: serialized.floorplan,
    items: backfillItemDescriptions(serialized.items),
  });
  return {
    model,
    modelJson: toMinifiedJSON(model),
    unitCatalogSummary: buildUnitCatalogSummary(units),
  };
}

/** The one method serializeFloorForAI actually needs off a live Blueprint3d
 * — narrow on purpose (rather than the full Blueprint3d type) so a
 * one-method fake can stand in for tests. A real Blueprint3d satisfies this
 * structurally, extra members and all. */
export interface SerializableStudioModel {
  model: { exportSerialized(): string };
}

/** The thin part: pull the current floor's {floorplan, items} off the live
 * Blueprint3d instance and hand it to buildStudioAssistPayload. */
export function serializeFloorForAI(
  bp: SerializableStudioModel,
  units: Array<{ name: string; config: UnitConfig }>,
): StudioAssistPayload {
  const serialized = JSON.parse(bp.model.exportSerialized()) as {
    floorplan: StudioSavedFloorplan;
    items: StudioSerializedItem[];
  };
  return buildStudioAssistPayload(serialized, units);
}

// ---------------------------------------------------------------------------
// Resolving a proposal back onto the live model
// ---------------------------------------------------------------------------

/** Exactly the wall accessors StudioWall already exposes — kept narrow so a
 * fake wall (or the live vendor one) both satisfy it. */
export interface WallEndpoints {
  getStartX(): number;
  getStartY(): number;
  getEndX(): number;
  getEndY(): number;
}

/** A proposal's `wall` is a 0-based index into layout.walls, the same array
 * order bp.model.floorplan.walls round-trips through — see
 * simplify-canvas-data.ts and _shared/studioAssist.ts's system prompt. Turns
 * {wall, xCm} into a plan-space {x, y} point ON that wall, clamped to its
 * length, ready for insertUnit's `atCm` param. Null when the index no longer
 * resolves (the model moved between the question and the click). */
export function resolveWallPoint(
  walls: WallEndpoints[],
  wallIndex: number,
  xCm: number,
): { x: number; y: number } | null {
  const wall = walls[wallIndex];
  if (!wall) return null;
  const ax = wall.getStartX();
  const ay = wall.getStartY();
  const bx = wall.getEndX();
  const by = wall.getEndY();
  const len = Math.hypot(bx - ax, by - ay);
  if (!(len > 0)) return { x: ax, y: ay };
  const t = Math.max(0, Math.min(1, xCm / len));
  return { x: ax + t * (bx - ax), y: ay + t * (by - ay) };
}

/** Plain-words label for a proposal card — "2-panel slider — the 14'0" wall,
 * about 4'2" from its start" — or a generic fallback once the wall it named
 * no longer resolves (still lets the card explain what's being added). */
export function describeProposal(
  walls: WallEndpoints[],
  proposal: AddUnitProposal,
): string {
  const n = proposal.config.panels.length;
  const kind = proposal.config.kind === "door" ? "door" : "window";
  const unit = `${n}-panel ${kind}`;
  const wall = walls[proposal.wall];
  if (!wall) return `${unit} — that wall isn't on the model anymore`;
  const len = Math.hypot(
    wall.getEndX() - wall.getStartX(),
    wall.getEndY() - wall.getStartY(),
  );
  const at = Math.max(0, Math.min(proposal.xCm, len));
  return `${unit} — the ${fmtFtIn(len)} wall, about ${fmtFtIn(at)} from its start`;
}

/** A plain, deterministic name for a proposed unit — the JSON block never
 * carries one (see the system prompt), so the client makes one up rather
 * than requiring the model to. */
export function defaultUnitName(config: AddUnitProposalConfig): string {
  const kind = config.kind === "door" ? "door" : "window";
  return `AI suggestion — ${config.panels.length}-panel ${kind}`;
}

// ---------------------------------------------------------------------------
// The network call
// ---------------------------------------------------------------------------

export interface StudioAssistResult {
  answer: string;
  /** True when the server declined to pay for an answer (out of today's AI
   * questions, or the company's monthly ceiling) — see docs/ai-spend-limits.md.
   * NOT an error: `note` is a quiet line to show above whatever's already
   * in the thread. */
  limited?: boolean;
  note?: string;
}

/** Same shape as knowledge.ts's private `functionError` — a Supabase Edge
 * Function non-2xx surfaces as a generic error whose real `{error}` body
 * lives unparsed on `.context`. */
async function functionError(error: unknown): Promise<Error> {
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const body = await ctx.json();
      if (body?.error) return new Error(String(body.error));
    } catch {
      // fall through to the generic message
    }
  }
  return error instanceof Error ? error : new Error(formatApiError(error));
}

/** Ask the `studio-assist` function about the current model. An oversized
 * payload never reaches the network — it comes back the same shape as a
 * server-side spend refusal (`answer: ""`, `note` set), so the card can
 * render both identically. Any other failure (network, non-2xx, malformed
 * body) throws — the caller is expected to show a plain "try again" line,
 * same as AskInfinity does for the `ask` function. */
export async function askStudioAssist(
  question: string,
  payload: StudioAssistPayload,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<StudioAssistResult> {
  const size = checkModelSize(payload.modelJson);
  if (!size.ok) {
    // Refused before the network call, in the caller's own words — never
    // spend a request (or a daily question) on a payload we already know
    // the server will also refuse.
    return { answer: "", note: size.message };
  }
  const { data, error } = await supabase.functions.invoke("studio-assist", {
    body: {
      question,
      model: payload.model,
      unitCatalogSummary: payload.unitCatalogSummary,
      history,
    },
  });
  if (error) throw await functionError(error);
  if (data?.error) throw new Error(String(data.error));
  return {
    answer: String(data?.answer ?? "").trim(),
    ...(data?.limited ? { limited: true } : {}),
    ...(typeof data?.note === "string" && data.note ? { note: data.note } : {}),
  };
}
