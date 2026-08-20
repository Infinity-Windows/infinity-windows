/**
 * Shared logic for the Model Studio "Ask about this model" assistant
 * (Studio 100x #42). Runtime-agnostic on purpose — this file is imported
 * BOTH by the `studio-assist` edge function (Deno) and by the app's client
 * code (`app/src/lib/modelstudio/aiAssist.ts`), exactly the way
 * `_shared/knowledge.ts` and `_shared/spendGuard.ts` already are. Keeping
 * the prompt, the size gate, and the reply parser here — instead of
 * duplicating them in the edge function and the browser — means the two
 * sides can never drift out of sync, and it's what makes this file testable
 * from `npm test` even though the edge function itself runs on Deno and has
 * no test runner of its own in this repo's gate.
 *
 * Scope is deliberately small (v1, owner-approved): READ the current
 * model + ANSWER questions about it, and propose at most ONE structured
 * edit per reply — adding a single unit to a wall. No deletes, no wall
 * edits. See ModelStudio.tsx's `insertUnit` for why: that's the ONE path
 * a proposed unit is ever inserted through, so every validation an
 * install-by-hand drag already gets (placeInRoom, snapIfCorner,
 * growWallToFit) applies to an AI-proposed one too.
 */

export interface HistoryTurn {
  role: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Size cap — the simplified model payload must stay small. ~8KB keeps a turn
// a couple thousand tokens and a couple cents; a raw serialized floorplan
// (full UUIDs, materials, every mesh's technical name) can run 10-20x that
// for the same building, which is exactly the bloat simplifyCanvasData
// exists to strip. Enforced client-side, BEFORE any network call, so a huge
// floor gets a plain-words refusal instead of a slow/expensive request; the
// edge function checks it again as cheap defense in depth.
// ---------------------------------------------------------------------------

export const MAX_MODEL_JSON_BYTES = 8192;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export type ModelSizeCheck =
  | { ok: true; bytes: number }
  | { ok: false; bytes: number; message: string };

/** Refuse, in plain words, a simplified-model payload bigger than the cap.
 * Never throws — a size problem is something to say out loud, not crash on. */
export function checkModelSize(modelJson: string): ModelSizeCheck {
  const bytes = byteLength(typeof modelJson === "string" ? modelJson : "");
  if (bytes <= MAX_MODEL_JSON_BYTES) return { ok: true, bytes };
  const kb = (n: number) => Math.max(1, Math.round(n / 1024));
  return {
    ok: false,
    bytes,
    message:
      `This floor's model is too big for the assistant right now ` +
      `(${kb(bytes)}KB, limit ${kb(MAX_MODEL_JSON_BYTES)}KB) — try asking ` +
      "on a smaller floor, or after moving some units to another floor.",
  };
}

// ---------------------------------------------------------------------------
// System prompt + user-turn assembly
// ---------------------------------------------------------------------------

export const STUDIO_ASSIST_SYSTEM_PROMPT =
  "You are the Model Studio assistant for a window and door installation " +
  "company. Every turn you're given a compact JSON snapshot of the CURRENT " +
  "floor's model and a short summary of the company's saved unit catalog. " +
  "In the model JSON: corners are [x,y] in cm; layout.walls is an array " +
  "where each entry is {corners:[startCornerIndex,endCornerIndex]} and a " +
  "wall's 0-based position in THAT ARRAY is its only id — call it wall N " +
  "when you mean layout.walls[N]; layout.areas are rooms as corner-index " +
  "boundaries; items are units already placed, each with pos [x,y,z] cm, " +
  "rot (radians), scale, and description when the unit has a name. There is " +
  "no compass or floor label in the data — if asked which wall or floor " +
  "something is on, work it out from the item's pos versus the wall/corner " +
  "coordinates you were given, and describe the wall by its position or " +
  "approximate length rather than inventing a name like \"north wall\". " +
  "Answer plainly and factually — counts, sizes, what's on which wall. Only " +
  "say what the data shows; never invent a wall, unit, or dimension that " +
  "isn't in it, and never invent an item's name beyond its description. " +
  "\n\n" +
  "You may propose ONE change per reply: adding a single new unit to a " +
  "wall. Only do this when the user is actually asking for a unit to be " +
  "added — never on a plain question. To propose one: first say what " +
  "you're proposing in one short plain sentence, then include EXACTLY ONE " +
  "fenced code block containing nothing else but this JSON shape (no " +
  "comments, no trailing text inside the fence):\n" +
  "```json\n" +
  '{"action":"add_unit","wall":0,"xCm":120,"config":{"kind":"window",' +
  '"heightMm":1200,"panels":[{"widthMm":900,"mechanism":"slider"}]}}\n' +
  "```\n" +
  'Field meanings: "wall" is the 0-based index into layout.walls named ' +
  'above; "xCm" is the distance in cm from that wall\'s start corner to ' +
  'where the new unit\'s center should land; "config.kind" is "window" or ' +
  '"door"; "config.heightMm" is the unit\'s overall height in mm; each ' +
  'panel\'s "mechanism" is one of fixed, slider, bifold, casement, hung. ' +
  "Never propose deleting a unit or changing a wall — those aren't " +
  "supported yet, so don't suggest them even if asked; say plainly that " +
  "you can only add units right now. Omit the JSON block entirely on any " +
  "turn that isn't a request to add something. Keep prose short — a " +
  "sentence or two.";

/** Assemble the one user turn: the model, the catalog, then the question —
 * in that order, so the stable, larger blocks sit first. */
export function buildStudioAssistUserMessage(
  question: string,
  modelJson: string,
  unitCatalogSummaryJson: string,
): string {
  const q = (typeof question === "string" ? question : "").trim();
  const model = typeof modelJson === "string" && modelJson ? modelJson : "{}";
  const catalog =
    typeof unitCatalogSummaryJson === "string" && unitCatalogSummaryJson
      ? unitCatalogSummaryJson
      : "[]";
  return (
    `Current model (JSON):\n${model}\n\n` +
    `Saved unit catalog (JSON):\n${catalog}\n\n` +
    `Question:\n${q}`
  );
}

// ---------------------------------------------------------------------------
// Proposal parsing — pulls the optional {action:"add_unit",...} block out of
// the model's reply text. Deliberately loose on the OPTIONAL config fields
// (cornerAfterPanel, rows, insetOutset, weightLb, frameColor) and strict on
// the load-bearing ones (kind, heightMm, panels[].widthMm/mechanism):
// insertUnit()/applyUnitGeometry() are the real validation gate on the
// client (Studio 100x #42's whole point — proposals go through the SAME
// path a human drag-drop does), so this only needs to keep obviously broken
// JSON from reaching them.
// ---------------------------------------------------------------------------

export type AddUnitMechanism =
  | "fixed"
  | "slider"
  | "bifold"
  | "casement"
  | "hung";

export interface AddUnitProposalPanel {
  widthMm: number;
  mechanism: AddUnitMechanism;
  direction?: "left" | "right";
  slideCount?: number;
}

export interface AddUnitProposalConfig {
  kind: "window" | "door";
  heightMm: number;
  panels: AddUnitProposalPanel[];
  cornerAfterPanel?: number | null;
  rows?: Array<{ heightMm: number }> | null;
  insetOutset?: "inset" | "outset" | null;
  weightLb?: number | null;
  frameColor?: "white" | "bronze" | "black";
}

export interface AddUnitProposal {
  action: "add_unit";
  /** 0-based index into the model's layout.walls. */
  wall: number;
  /** cm from that wall's start corner to the unit's center. */
  xCm: number;
  config: AddUnitProposalConfig;
}

export interface ParsedReply {
  /** The reply with the (first valid) proposal's fenced block removed —
   * this is what renders as the chat bubble's text. */
  prose: string;
  /** Null when the reply carried no valid add_unit proposal. */
  proposal: AddUnitProposal | null;
}

const MECHANISMS: ReadonlySet<string> = new Set([
  "fixed",
  "slider",
  "bifold",
  "casement",
  "hung",
]);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function readPanel(raw: unknown): AddUnitProposalPanel | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (!isFiniteNumber(p.widthMm) || p.widthMm <= 0) return null;
  if (typeof p.mechanism !== "string" || !MECHANISMS.has(p.mechanism)) return null;
  const panel: AddUnitProposalPanel = {
    widthMm: p.widthMm,
    mechanism: p.mechanism as AddUnitMechanism,
  };
  if (p.direction === "left" || p.direction === "right") panel.direction = p.direction;
  if (isFiniteNumber(p.slideCount)) panel.slideCount = p.slideCount;
  return panel;
}

function readRows(raw: unknown): Array<{ heightMm: number }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: Array<{ heightMm: number }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const heightMm = (entry as Record<string, unknown>).heightMm;
    if (isFiniteNumber(heightMm) && heightMm > 0) rows.push({ heightMm });
  }
  return rows.length > 0 ? rows : undefined;
}

function readConfig(raw: unknown): AddUnitProposalConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (c.kind !== "window" && c.kind !== "door") return null;
  if (!isFiniteNumber(c.heightMm) || c.heightMm <= 0) return null;
  if (!Array.isArray(c.panels) || c.panels.length === 0) return null;

  const panels: AddUnitProposalPanel[] = [];
  for (const rawPanel of c.panels) {
    const panel = readPanel(rawPanel);
    if (!panel) return null; // one bad panel invalidates the whole proposal
    panels.push(panel);
  }

  const config: AddUnitProposalConfig = { kind: c.kind, heightMm: c.heightMm, panels };
  if (isFiniteNumber(c.cornerAfterPanel)) config.cornerAfterPanel = c.cornerAfterPanel;
  if (c.insetOutset === "inset" || c.insetOutset === "outset") {
    config.insetOutset = c.insetOutset;
  }
  if (isFiniteNumber(c.weightLb) && c.weightLb > 0) config.weightLb = c.weightLb;
  if (c.frameColor === "white" || c.frameColor === "bronze" || c.frameColor === "black") {
    config.frameColor = c.frameColor;
  }
  const rows = readRows(c.rows);
  if (rows) config.rows = rows;

  return config;
}

function readProposal(raw: unknown): AddUnitProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.action !== "add_unit") return null;
  if (!isFiniteNumber(o.wall) || o.wall < 0 || !Number.isInteger(o.wall)) return null;
  if (!isFiniteNumber(o.xCm) || o.xCm < 0) return null;
  const config = readConfig(o.config);
  if (!config) return null;
  return { action: "add_unit", wall: o.wall, xCm: o.xCm, config };
}

/** Pull the (first well-formed) add_unit proposal out of a reply's fenced
 * code blocks, and return the reply with that block stripped out for
 * display. A reply with no fenced block, or none that parses as a valid
 * add_unit, comes back with the text unchanged and `proposal: null` —
 * never throws, so a model that ignores the format degrades to a plain
 * answer instead of breaking the chat. */
export function parseAddUnitProposal(text: string): ParsedReply {
  const raw = typeof text === "string" ? text : "";
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(raw)) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    const proposal = readProposal(parsed);
    if (proposal) {
      const prose = (raw.slice(0, match.index) + raw.slice(match.index + match[0].length)).trim();
      return { prose, proposal };
    }
  }
  return { prose: raw.trim(), proposal: null };
}
