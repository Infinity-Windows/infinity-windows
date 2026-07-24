// Extract rich per-mark window/door line-item specs from planset page text with
// Claude. The specs planset defines what each MARK is; we pull the FULL
// manufacturer line-item (style, glass, color, size code, operation, energy
// numbers, …) once per mark so the crew can see exactly what they're installing.
//
// Parsing is defensive: a bad/garbled line is skipped, never thrown. The client
// (`lib/install/specs.ts`) does the deterministic size-code decode and final
// normalization/merge, so this function just returns best-effort raw fields.

import { corsHeaders, jsonResponse } from "../_shared/openai.ts";
import { anthropicChat, requireAnthropic } from "../_shared/anthropic.ts";
import { requireCaller } from "../_shared/auth.ts";

interface RawSpec {
  mark_code: string;
  style: string | null;
  glass: string | null;
  color: string | null;
  size_code: string | null;
  operation: string | null;
  tempered: boolean | null;
  egress: boolean | null;
  u_factor: number | null;
  shgc: number | null;
  grids: string | null;
  screen: string | null;
  product_line: string | null;
  extra: Record<string, unknown> | null;
}

/** Pull the first JSON object out of an LLM reply, tolerating ``` fences. */
function parseJsonLoose(text: string): unknown {
  if (!text) return null;
  let s = text.trim();
  // Strip a leading ```json / ``` fence and its closing fence when present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // Fall back to the first {...} span so a chatty preamble can't break us.
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function boolOrNull(v: unknown): boolean | null {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "yes", "y", "1", "tempered", "egress"].includes(s)) return true;
  if (["false", "no", "n", "0", "none", "n/a", "na"].includes(s)) return false;
  return null;
}

/** Coerce one loose object into a RawSpec, or null when it has no usable mark. */
function cleanSpec(raw: unknown): RawSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const mark =
    str(o.mark_code) ?? str(o.mark) ?? str(o.markCode) ?? str(o.opening);
  if (!mark) return null;
  const extraRaw = o.extra;
  const extra =
    extraRaw && typeof extraRaw === "object" && !Array.isArray(extraRaw)
      ? (extraRaw as Record<string, unknown>)
      : null;
  return {
    mark_code: mark.replace(/^#/, "").toUpperCase(),
    style: str(o.style) ?? str(o.type),
    glass: str(o.glass) ?? str(o.glazing),
    color: str(o.color) ?? str(o.colour) ?? str(o.finish),
    size_code: str(o.size_code) ?? str(o.sizeCode) ?? str(o.size),
    operation: str(o.operation) ?? str(o.config),
    tempered: boolOrNull(o.tempered),
    egress: boolOrNull(o.egress),
    u_factor: numOrNull(o.u_factor) ?? numOrNull(o.uFactor),
    shgc: numOrNull(o.shgc) ?? numOrNull(o.SHGC),
    grids: str(o.grids) ?? str(o.grille),
    screen: str(o.screen),
    product_line:
      str(o.product_line) ?? str(o.productLine) ?? str(o.manufacturer) ??
      str(o.series),
    extra: extra && Object.keys(extra).length > 0 ? extra : null,
  };
}

const SYSTEM =
  "You extract rich per-mark window and door line-item specifications from a " +
  "construction specs/schedule planset. Each MARK (e.g. 1, W3, A-101) is one " +
  "product line item shared by every instance of that mark. For each distinct " +
  "mark, capture the FULL manufacturer line-item as found in the text. Do not " +
  "invent values — use null for anything not present. Return STRICT JSON only, " +
  "no prose, no markdown fences.";

const SCHEMA =
  'Return exactly: { "specs": [ { ' +
  '"mark_code": string, ' +
  '"style": string|null, ' +
  '"glass": string|null, ' +
  '"color": string|null, ' +
  '"size_code": string|null, ' +
  '"operation": string|null, ' +
  '"tempered": boolean|null, ' +
  '"egress": boolean|null, ' +
  '"u_factor": number|null, ' +
  '"shgc": number|null, ' +
  '"grids": string|null, ' +
  '"screen": string|null, ' +
  '"product_line": string|null, ' +
  '"extra": object|null ' +
  "} ] }. " +
  'size_code is the raw manufacturer call size like "3060" when present. ' +
  "operation is XO/OX/Fixed/Casement/etc. Put any other line-item attributes " +
  "you find (hardware, spacer, frame depth, mulls, notes) into extra as a flat " +
  "object of string values. One entry per distinct mark.";

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const unauthorized = await requireCaller(req, cors);
  if (unauthorized) return unauthorized;

  try {
    requireAnthropic();
    const body = await req.json().catch(() => ({}));
    const pages = body.pages as
      | { pageNumber: number; text: string }[]
      | undefined;
    if (!Array.isArray(pages) || pages.length === 0) {
      return jsonResponse({ error: "pages[] required" }, 400, cors);
    }

    // Cap input like extract-schedule: keep a lot per page, batch under a char
    // budget, and cap the number of LLM calls so a huge planset can't blow up.
    const PER_PAGE_LIMIT = 24000;
    const BATCH_CHAR_BUDGET = 60000;
    const MAX_BATCHES = 8;

    const pageBlocks = pages.map(
      (p) =>
        `--- PAGE ${p.pageNumber} ---\n${(p.text ?? "").slice(0, PER_PAGE_LIMIT)}`,
    );
    const batches: string[] = [];
    let current = "";
    for (const block of pageBlocks) {
      if (current && current.length + block.length > BATCH_CHAR_BUDGET) {
        batches.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${block}` : block;
    }
    if (current) batches.push(current);
    const limited = batches.slice(0, MAX_BATCHES);

    const batchResults = await Promise.all(
      limited.map(async (text) => {
        try {
          const reply = await anthropicChat({
            system: `${SYSTEM}\n\n${SCHEMA}`,
            messages: [
              {
                role: "user",
                content: `Planset text:\n${text}\n\nReturn the JSON now.`,
              },
            ],
            maxTokens: 4096,
          });
          const parsed = parseJsonLoose(reply) as
            | { specs?: unknown[] }
            | unknown[]
            | null;
          const arr = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.specs)
              ? parsed!.specs
              : [];
          return arr
            .map(cleanSpec)
            .filter((s): s is RawSpec => s !== null);
        } catch (err) {
          console.error("extract-specs batch failed", err);
          return [] as RawSpec[];
        }
      }),
    );

    // Merge by mark: fill gaps across batches so a spec split over pages is
    // reunited, without one batch clobbering another's non-null values.
    const byMark = new Map<string, RawSpec>();
    for (const spec of batchResults.flat()) {
      const key = spec.mark_code.toUpperCase();
      const existing = byMark.get(key);
      if (!existing) {
        byMark.set(key, spec);
        continue;
      }
      for (const k of Object.keys(spec) as (keyof RawSpec)[]) {
        if (k === "mark_code") continue;
        if (existing[k] == null && spec[k] != null) {
          (existing as Record<string, unknown>)[k] = spec[k];
        }
      }
    }
    const specs = [...byMark.values()];

    return jsonResponse({ specs }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});
