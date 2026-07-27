// Extract rich per-mark window/door line-item specs from planset page text with
// Claude. The specs planset defines what each MARK is; we pull the FULL
// manufacturer line-item (style, glass, color, size code, operation, energy
// numbers, …) once per mark so the crew can see exactly what they're installing.
//
// Parsing is defensive: a bad/garbled line is skipped, never thrown. The client
// (`lib/install/specs.ts`) does the deterministic size-code decode and final
// normalization/merge, so this function just returns best-effort raw fields.

import { corsHeaders, jsonResponse } from "../_shared/openai.ts";
import {
  anthropicChat,
  anthropicVisionChat,
  dataUrlToImage,
  requireAnthropic,
} from "../_shared/anthropic.ts";
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

/** A verbatim vision transcription of one mark, before client normalization. */
interface RawVisionMark {
  mark: string;
  style: string | null;
  glass: string | null;
  color: string | null;
  size_code: string | null;
  operation: string | null;
  qty: string | null;
}

/** Coerce one loose vision object into a RawVisionMark, or null (no mark). */
function cleanVisionMark(raw: unknown): RawVisionMark | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const mark = str(o.mark) ?? str(o.mark_code) ?? str(o.markCode);
  if (!mark) return null;
  return {
    // Kept verbatim (e.g. "PV Townhomes Bldg 14-#4A"); the client strips the
    // project prefix / '#' with the unit-tested normalizeMarkLabel.
    mark,
    style: str(o.style) ?? str(o.type),
    glass: str(o.glass) ?? str(o.glazing),
    color: str(o.color) ?? str(o.colour) ?? str(o.finish),
    size_code: str(o.size_code) ?? str(o.sizeCode) ?? str(o.size),
    operation: str(o.operation) ?? str(o.config),
    qty: str(o.qty) ?? str(o.quantity) ?? str(o.count),
  };
}

const VISION_SYSTEM =
  "You transcribe a window & door manufacturer SHOP-DRAWING / spec sheet from " +
  "an IMAGE. The rich per-mark details (style, glass makeup, color, size code, " +
  "operation) are drawn into the sheet as graphics/text you must READ. " +
  "Transcribe the spec table EXACTLY as printed — do not paraphrase, do not " +
  "invent any value that is not visible (use null). Output one object per " +
  "distinct window/door MARK. Return STRICT JSON only, no prose, no markdown.";

const VISION_SCHEMA =
  'Return exactly: { "marks": [ { ' +
  '"mark": string, ' +
  '"style": string|null, ' +
  '"glass": string|null, ' +
  '"color": string|null, ' +
  '"size_code": string|null, ' +
  '"operation": string|null, ' +
  '"qty": string|null ' +
  "} ] }. " +
  'mark is the label exactly as printed on the sheet (e.g. "PV Townhomes Bldg ' +
  '14-#4A" or "#1"). Do NOT collapse two marks into one. size_code is the ' +
  'manufacturer call size like "3060" or "6080 XO" (keep the operation token ' +
  "if printed with it). operation is Fixed / Sliding / XO / OX / Casement / " +
  "etc. glass is the full glass makeup string if shown. One object per mark.";

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
    const images = body.images as
      | { pageNumber: number; dataUrl: string }[]
      | undefined;

    // PRIMARY path: page images. The rich per-mark specs on manufacturer shop
    // drawings (STRATA-style) are drawn into the PDF as graphics, so their text
    // layer is empty/scrambled — Claude VISION reads them perfectly. One page
    // per LLM call (page PNGs/JPEGs are large); cap total pages.
    if (Array.isArray(images) && images.length > 0) {
      const MAX_VISION_PAGES = 12;
      const limitedImages = images.slice(0, MAX_VISION_PAGES);

      const pageResults = await Promise.all(
        limitedImages.map(async (img) => {
          const parsedImg = dataUrlToImage(img.dataUrl ?? "");
          if (!parsedImg) return [] as RawVisionMark[];
          try {
            const reply = await anthropicVisionChat({
              system: `${VISION_SYSTEM}\n\n${VISION_SCHEMA}`,
              text:
                `This is page ${img.pageNumber} of a window/door spec sheet. ` +
                "Transcribe every distinct mark's line-item and return the JSON now.",
              images: [parsedImg],
              maxTokens: 4096,
            });
            const parsed = parseJsonLoose(reply) as
              | { marks?: unknown[] }
              | unknown[]
              | null;
            const arr = Array.isArray(parsed)
              ? parsed
              : Array.isArray(parsed?.marks)
                ? parsed!.marks
                : [];
            return arr
              .map(cleanVisionMark)
              .filter((s): s is RawVisionMark => s !== null);
          } catch (err) {
            console.error("extract-specs vision page failed", err);
            return [] as RawVisionMark[];
          }
        }),
      );

      // Merge by raw mark string so a mark split across pages is reunited
      // without one page clobbering another's non-null values.
      const byMark = new Map<string, RawVisionMark>();
      for (const mark of pageResults.flat()) {
        const key = mark.mark.trim().toUpperCase();
        const existing = byMark.get(key);
        if (!existing) {
          byMark.set(key, mark);
          continue;
        }
        for (const k of Object.keys(mark) as (keyof RawVisionMark)[]) {
          if (k === "mark") continue;
          if (existing[k] == null && mark[k] != null) {
            (existing as Record<string, unknown>)[k] = mark[k];
          }
        }
      }

      return jsonResponse(
        { specs: [...byMark.values()], mode: "vision" },
        200,
        cors,
      );
    }

    if (!Array.isArray(pages) || pages.length === 0) {
      return jsonResponse({ error: "pages[] or images[] required" }, 400, cors);
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

    return jsonResponse({ specs, mode: "text" }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});
