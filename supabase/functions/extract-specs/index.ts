// Extract rich per-mark window/door line-item specs from planset page text with
// Claude. The specs planset defines what each MARK is; we pull the FULL
// manufacturer line-item (style, glass, color, size code, operation, energy
// numbers, …) once per mark so the crew can see exactly what they're installing.
//
// The VISION path additionally reports WHERE each mark's elevation drawing sits
// on the page (a normalized bounding box) so the app can crop that picture out
// of the planset and show it next to the text, and transcribes the overall
// dimensions PRINTED on that drawing so the client can verify the call size
// decoded to the size the sheet actually states.
//
// Parsing is defensive: a bad/garbled line is skipped, never thrown. The client
// (`lib/install/specs.ts`) does the deterministic size-code decode and final
// normalization/merge, so this function just returns best-effort raw fields.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import {
  ANTHROPIC_MODEL,
  anthropicChat,
  anthropicVisionChat,
  dataUrlToImage,
  requireAnthropic,
  type AnthropicUsage,
} from "../_shared/anthropic.ts";
import { verifyCaller } from "../_shared/auth.ts";
import {
  notifyOwnersOfSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
  type SpendVerdict,
} from "../_shared/spendGuard.ts";

/** Running token total for one invocation. Every provider call adds to it, so
 * the ceiling is reconciled against what a whole planset actually cost. */
interface UsageTally {
  inputTokens: number;
  outputTokens: number;
}

function tally(into: UsageTally): (u: AnthropicUsage) => void {
  return (u) => {
    into.inputTokens += u.inputTokens ?? 0;
    into.outputTokens += u.outputTokens ?? 0;
  };
}

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
  /**
   * The overall width/height PRINTED beside the elevation, transcribed exactly
   * as shown — e.g. "901(35 1/2\")", "1816(71 1/2\")" (millimetres with the
   * inch equivalent in parentheses). The client uses these to verify the call
   * size decoded to the dimensions the sheet actually states.
   */
  printed_width: string | null;
  printed_height: string | null;
  /** Normalized [x0,y0,x1,y1] of this mark's elevation drawing on the page. */
  bbox: [number, number, number, number] | null;
  /** 1-based page the drawing (and this transcription) came from. */
  image_page: number | null;
}

/**
 * Validate a bounding box the model returned for a mark's elevation drawing.
 * Mirrors the client's `validateBbox`: four finite numbers in 0..1, positive
 * width and height, and an area that is neither the whole sheet (the model
 * shrugging) nor a speck (a tick mark it mistook for a drawing). An unusable
 * box becomes null so the mark's TEXT still survives — a bad picture must never
 * cost us the spec.
 */
function cleanBbox(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const nums = raw.map((v) => (typeof v === "number" ? v : Number(v)));
  if (!nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  const [x0, y0, x1, y1] = nums as [number, number, number, number];
  if (x1 <= x0 || y1 <= y0) return null;
  const area = (x1 - x0) * (y1 - y0);
  if (area > 0.9 || area < 0.002) return null;
  return [x0, y0, x1, y1];
}

/** Coerce one loose vision object into a RawVisionMark, or null (no mark). */
function cleanVisionMark(raw: unknown, pageNumber: number): RawVisionMark | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const mark = str(o.mark) ?? str(o.mark_code) ?? str(o.markCode);
  if (!mark) return null;
  const bbox = cleanBbox(o.bbox ?? o.box ?? o.drawing_bbox);
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
    // Kept verbatim, units and all — the client parses them. Only the keys we
    // asked for are accepted: a loose `width` could just as easily be the model
    // echoing the decoded call size, and a wrong dimension that OVERRIDES the
    // size code is worse than no dimension at all.
    printed_width: str(o.printed_width) ?? str(o.printedWidth),
    printed_height: str(o.printed_height) ?? str(o.printedHeight),
    bbox,
    // The page is ours, not the model's — we know which image we sent. Only
    // meaningful alongside a box, so it rides along with one.
    image_page:
      bbox && Number.isInteger(pageNumber) && pageNumber >= 1
        ? pageNumber
        : null,
  };
}

/**
 * What happened on ONE page of the specs planset. Returned alongside the marks
 * so a FAILED page is never mistaken for an EMPTY one — the whole point of this
 * shape. On the real Smith job a page's vision call came back with zero marks
 * and the client had no way to tell that from "this sheet has no marks on it",
 * so a mark quietly lost its drawing.
 *
 *   ok        — the last attempt completed without throwing. A page can be
 *               `ok` with `markCount: 0` (a genuine cover/detail sheet).
 *   attempts  — how many vision calls we made (1–3), so the UI can say
 *               "failed after 3 attempts".
 *   error     — short, sanitized reason, only present when `ok` is false.
 */
interface VisionPageStatus {
  pageNumber: number;
  ok: boolean;
  attempts: number;
  markCount: number;
  error?: string;
}

/** One initial vision call plus at most two retries per page. */
const VISION_PAGE_ATTEMPTS = 3;
/** Backoff before attempt 2 and attempt 3 — short; a foreman is waiting. */
const VISION_RETRY_DELAYS_MS = [400, 1200];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reduce an unknown thrown value to a SHORT, safe message for the client.
 * Upstream errors carry the whole provider response body, which is noisy and is
 * exactly the sort of thing that must not be piped into a foreman's screen, so
 * anything key-shaped is redacted, base64/data-url blobs are dropped, and the
 * result is clipped hard.
 */
function shortError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const cleaned = raw
    .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/g, "[image]")
    .replace(/\b(?:sk|sk-ant|api)[-_][A-Za-z0-9-_]{8,}/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "vision call failed";
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}…` : cleaned;
}

const VISION_SYSTEM =
  "You transcribe a window & door manufacturer SHOP-DRAWING / spec sheet from " +
  "an IMAGE. The rich per-mark details (style, glass makeup, color, size code, " +
  "operation) are drawn into the sheet as graphics/text you must READ. " +
  "Transcribe the spec table EXACTLY as printed — do not paraphrase, do not " +
  "invent any value that is not visible (use null). You ALSO transcribe the " +
  "overall dimensions PRINTED on each mark's drawing, verbatim, and locate " +
  "each mark's ELEVATION DRAWING (the line drawing of the unit, usually " +
  'captioned "Outside View") and report where it sits on the page. One object ' +
  "per distinct window/door MARK. Return STRICT JSON only, no prose, no " +
  "markdown.";

const VISION_SCHEMA =
  'Return exactly: { "marks": [ { ' +
  '"mark": string, ' +
  '"style": string|null, ' +
  '"glass": string|null, ' +
  '"color": string|null, ' +
  '"size_code": string|null, ' +
  '"operation": string|null, ' +
  '"qty": string|null, ' +
  '"printed_width": string|null, ' +
  '"printed_height": string|null, ' +
  '"bbox": [number, number, number, number]|null ' +
  "} ] }. " +
  'mark is the label exactly as printed on the sheet (e.g. "PV Townhomes Bldg ' +
  '14-#4A" or "#1"). Do NOT collapse two marks into one. size_code is the ' +
  'manufacturer call size like "3060" or "6080 XO" (keep the operation token ' +
  "if printed with it). operation is Fixed / Sliding / XO / OX / Casement / " +
  "etc. glass is the full glass makeup string if shown. " +
  "printed_width and printed_height are the OVERALL width and height " +
  "DIMENSIONS PRINTED on that mark's elevation drawing (on or beside its " +
  "dimension lines) — the horizontal one is the width, the vertical one is " +
  "the height. TRANSCRIBE THEM CHARACTER FOR CHARACTER, including units, " +
  "fractions and any parenthesised inch equivalent — a sheet printing " +
  '901(35 1/2") must come back as exactly that string, not 901 and not 35.5. ' +
  "Do NOT convert, round, average or paraphrase them, and do NOT copy the " +
  "call size into them. Use null when no overall dimension is printed for " +
  "that mark. " +
  "bbox is the bounding box of THAT MARK'S ELEVATION DRAWING ONLY, as " +
  "[x0, y0, x1, y1] normalized 0..1 against the FULL page, origin at the TOP-" +
  "LEFT corner (x grows right, y grows down). INCLUDE the drawing's dimension " +
  'lines, leader labels, and its "Outside View" caption. EXCLUDE the spec ' +
  "table / text block printed below or beside it, and exclude every other " +
  "mark's drawing. Use null if you cannot see a drawing for that mark. One " +
  "object per mark.";

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

/**
 * Run the vision pass over ONE rendered page, retrying up to
 * {@link VISION_PAGE_ATTEMPTS} times, and report what happened.
 *
 * A retry is worth it in both failure shapes we actually saw in the field:
 *   • the call THREW (provider 429/500/timeout) — obviously transient;
 *   • the call succeeded but yielded ZERO marks on a page that plainly has a
 *     spec table. That's the model shrugging, and asking again is the cheapest
 *     fix; it's also why the retry can't be limited to thrown errors.
 * The last attempt's outcome is what we report. A page that keeps returning no
 * marks without ever throwing stays `ok` — it may genuinely be a cover sheet —
 * but `markCount: 0` lets the client say so out loud either way.
 */
async function extractVisionPage(
  img: { pageNumber: number; dataUrl: string },
  usage: UsageTally,
): Promise<{ marks: RawVisionMark[]; status: VisionPageStatus }> {
  const pageNumber = img.pageNumber;
  const parsedImg = dataUrlToImage(img.dataUrl ?? "");
  if (!parsedImg) {
    return {
      marks: [],
      status: {
        pageNumber,
        ok: false,
        attempts: 0,
        markCount: 0,
        error: "page image was missing or not a base64 data URL",
      },
    };
  }

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= VISION_PAGE_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await sleep(VISION_RETRY_DELAYS_MS[attempt - 2] ?? 1200);
    }
    try {
      const reply = await anthropicVisionChat({
        system: `${VISION_SYSTEM}\n\n${VISION_SCHEMA}`,
        text:
          `This is page ${pageNumber} of a window/door spec sheet. ` +
          "Transcribe every distinct mark's line-item, locate each " +
          "mark's elevation drawing, and return the JSON now.",
        images: [parsedImg],
        maxTokens: 4096,
        onUsage: tally(usage),
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
      const marks = arr
        .map((m) => cleanVisionMark(m, pageNumber))
        .filter((s): s is RawVisionMark => s !== null);

      // Zero marks is retryable, but only while we have attempts left; the
      // final empty answer is reported as a successful-but-empty page.
      if (marks.length === 0 && attempt < VISION_PAGE_ATTEMPTS) {
        lastError = "no marks returned";
        continue;
      }
      return {
        marks,
        status: { pageNumber, ok: true, attempts: attempt, markCount: marks.length },
      };
    } catch (err) {
      console.error(
        `extract-specs vision page ${pageNumber} attempt ${attempt} failed`,
        err,
      );
      lastError = shortError(err);
    }
  }

  return {
    marks: [],
    status: {
      pageNumber,
      ok: false,
      attempts: VISION_PAGE_ATTEMPTS,
      markCount: 0,
      error: lastError ?? "vision call failed",
    },
  };
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const auth = await verifyCaller(req);
  if (auth.status === "unauthorized") {
    return jsonResponse({ error: "unauthorized" }, 401, cors);
  }
  const callerId =
    auth.status === "ok" && auth.user.id !== "service_role" ? auth.user.id : null;

  try {
    requireAnthropic();
    const body = await req.json().catch(() => ({}));
    const pages = body.pages as
      | { pageNumber: number; text: string }[]
      | undefined;
    const images = body.images as
      | { pageNumber: number; dataUrl: string }[]
      | undefined;

    // Spend guard, write-time. Reading a plan set is the one AI cost in this app
    // that is genuinely per-job rather than per-curiosity: it happens once when
    // a planset lands, an owner or foreman triggers it from a review screen, and
    // what it produces is the schedule the whole install runs off. So it carries
    // NO role floor beyond the existing foreman-only route and NO per-user daily
    // count — a 12-page spec sheet legitimately makes 12 calls in one breath.
    // It is metered, and it stops at the company ceiling (with the write-time
    // headroom multiplier), so it can never be the thing that surprises anyone.
    const meter =
      SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
        ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        : null;
    const usage: UsageTally = { inputTokens: 0, outputTokens: 0 };
    const units = Math.max(
      1,
      Array.isArray(images) && images.length > 0
        ? Math.min(images.length, 12)
        : Array.isArray(pages)
          ? Math.min(pages.length, 8)
          : 1,
    );
    const gate: SpendVerdict = await reserveAiSpend(meter, {
      userId: callerId,
      functionName: "extract-specs",
      units,
    });
    if (gate.alert) {
      await notifyOwnersOfSpend(gate.alert, gate.alertProfileIds, {
        supabaseUrl: SUPABASE_URL,
        serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
      });
    }
    if (!gate.allowed) {
      return jsonResponse(
        {
          specs: [],
          mode: "limited",
          pages: [],
          limited: true,
          limit_reason: gate.reason,
          note: "The company's monthly AI budget is used up, so this plan set wasn't read. An owner can raise the ceiling on the AI spend screen and run the extraction again.",
        },
        200,
        cors,
      );
    }

    /** Book the real cost once, on whichever path returns. */
    const settle = () =>
      usage.inputTokens === 0 && usage.outputTokens === 0
        ? releaseAiSpend(meter, gate.reservationId, "no_provider_response", true)
        : settleAiSpend(meter, gate.reservationId, usage, ANTHROPIC_MODEL);

    // PRIMARY path: page images. The rich per-mark specs on manufacturer shop
    // drawings (STRATA-style) are drawn into the PDF as graphics, so their text
    // layer is empty/scrambled — Claude VISION reads them perfectly. One page
    // per LLM call (page PNGs/JPEGs are large); cap total pages.
    if (Array.isArray(images) && images.length > 0) {
      const MAX_VISION_PAGES = 12;
      const limitedImages = images.slice(0, MAX_VISION_PAGES);

      const pageResults = await Promise.all(
        limitedImages.map((img) => extractVisionPage(img, usage)),
      );

      // Merge by raw mark string so a mark split across pages is reunited
      // without one page clobbering another's non-null values.
      const byMark = new Map<string, RawVisionMark>();
      for (const mark of pageResults.flatMap((r) => r.marks)) {
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

      await settle();
      return jsonResponse(
        {
          specs: [...byMark.values()],
          mode: "vision",
          pages: pageResults.map((r) => r.status),
        },
        200,
        cors,
      );
    }

    if (!Array.isArray(pages) || pages.length === 0) {
      await releaseAiSpend(meter, gate.reservationId, "no_pages", true);
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
            onUsage: tally(usage),
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

    await settle();
    // `pages` is always present so the client never has to branch on its
    // absence; it's empty here because the text path batches several pages into
    // one LLM call, so there is no honest per-page outcome to report.
    return jsonResponse({ specs, mode: "text", pages: [] }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});
