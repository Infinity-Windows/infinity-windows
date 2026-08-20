import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import {
  ANTHROPIC_MODEL,
  anthropicChatJson,
  requireAnthropic,
} from "../_shared/anthropic.ts";
import { verifyCaller } from "../_shared/auth.ts";
import { anthropicVisionChat, dataUrlToImage } from "../_shared/anthropic.ts";
import { parseJsonLoose } from "../_shared/anthropicJson.ts";
import {
  notifyOwnersOfSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} from "../_shared/spendGuard.ts";

interface ScheduleRow {
  openingCode: string;
  typeText: string;
  qty: number;
  label: string | null;
  pageNumber: number;
  widthIn?: number | null;
  heightIn?: number | null;
  color?: string | null;
  kind?: string | null;
}

const SCHEDULE_SCHEMA = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          openingCode: { type: "string" },
          typeText: { type: "string" },
          qty: { type: "number" },
          label: { type: ["string", "null"] },
          pageNumber: { type: "number" },
          widthIn: { type: ["number", "null"] },
          heightIn: { type: ["number", "null"] },
          color: { type: ["string", "null"] },
          kind: { type: "string", enum: ["window", "door"] },
        },
        required: ["openingCode", "typeText", "qty", "pageNumber"],
      },
    },
  },
  required: ["rows"],
};

function cleanAndDedupe(raw: ScheduleRow[]): ScheduleRow[] {
  const clean = raw
    .filter((r) => r && typeof r.openingCode === "string" && r.openingCode.trim())
    .map((r) => ({
      // The NO: field may carry the project name ("Oak Valley Estates 5 - #12");
      // the mark is what follows the last '#' or ' - ' separator.
      openingCode: String(r.openingCode)
        .trim()
        .replace(/^.*#/, "")
        .replace(/^.*\s[-\u2013]\s*/, "")
        .trim()
        .toUpperCase() || String(r.openingCode).trim().toUpperCase(),
      typeText: String(r.typeText ?? "").trim().toUpperCase() || "UNKNOWN",
      qty: Math.min(500, Math.max(1, Number(r.qty) || 1)),
      label: r.label ? String(r.label).trim() : null,
      pageNumber: Number(r.pageNumber) || 1,
      widthIn: r.widthIn != null && Number.isFinite(Number(r.widthIn)) ? Number(r.widthIn) : null,
      heightIn: r.heightIn != null && Number.isFinite(Number(r.heightIn)) ? Number(r.heightIn) : null,
      color: r.color ? String(r.color).trim().toUpperCase() : null,
      kind: String(r.kind ?? "").toLowerCase() === "door" ? ("door" as const) : ("window" as const),
    }));
  // Reads can overlap or repeat a mark; keep one row per mark+page and
  // prefer the larger quantity so nothing is under-counted.
  const byKey = new Map<string, (typeof clean)[number]>();
  for (const row of clean) {
    const key = `${row.openingCode}@${row.pageNumber}`;
    const existing = byKey.get(key);
    if (!existing || row.qty > existing.qty) byKey.set(key, row);
  }
  return [...byKey.values()];
}

/**
 * The trained rule (owner, 2026-08-20, proven on RAC-OAK-5): a mark exists
 * exactly as many times as its cut-sheet cell's QTY says — and ONLY marks
 * with a pictured cell exist at all. Elevation labels are placement hints,
 * never counts; annotations and handwriting are ignored; a cell missing its
 * drawing or its QTY is a plans-side error and is skipped, not guessed.
 */
const VISION_SYSTEM =
  "You read window & door order documents for a window company. Pages come in two kinds. " +
  "(A) CUT-SHEET pages: a grid of bordered cells, each describing ONE product with: a technical line drawing of the unit, " +
  "a NO: field whose value ends in the mark (e.g. 'Oak Valley Estates 5 - #12' means openingCode '12'; 'W1' stays 'W1'), " +
  "a QTY field, style/Glass/color text, and overall dimensions (millimetres with inches in parentheses). " +
  "(B) ELEVATION or FLOOR-PLAN pages: whole-building drawings sprinkled with mark-number labels. " +
  "Rules, in priority order: " +
  "1. Return one row per cut-sheet cell that has BOTH a drawing AND an explicit QTY value. A cell missing either is a plans-side error - skip it. " +
  "A drawing means an actual technical illustration of the unit. A cell whose drawing area is blank, or crossed out with a diagonal slash, has NO drawing - skip it even if its QTY and style text are filled in (proven on Oak Valley Estates 5, where a slashed-out #18 cell still carried QTY 2). " +
  "2. qty comes ONLY from the QTY field. NEVER derive a quantity from how many times a number appears on any drawing, elevation, or page. " +
  "3. Elevation and floor-plan pages contribute NOTHING - no rows, ever. " +
  "4. Ignore handwritten or colored annotations anywhere; only printed fields count. " +
  "5. widthIn/heightIn = the drawing's OUTERMOST overall frame dimensions, in inches. " +
  "6. kind is 'door' when the style text says door, else 'window'. " +
  'Reply with STRICT JSON only: { "rows": [ { "openingCode": string, "typeText": string, "qty": number, "label": string|null, "pageNumber": number, "widthIn": number|null, "heightIn": number|null, "color": string|null, "kind": "window"|"door" } ] }';

async function visionScheduleRead(
  images: { pageNumber: number; dataUrl: string }[],
  catalog: { type_code: string; name: string }[],
  callerId: string | null,
  cors: Record<string, string>,
): Promise<Response> {
  const meter =
    SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
      ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
      : null;
  const capped = images.slice(0, 24);
  const gate = await reserveAiSpend(meter, {
    userId: callerId,
    functionName: "extract-schedule",
    units: capped.length,
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
        rows: [],
        limited: true,
        limit_reason: gate.reason,
        note: "The company's monthly AI budget is used up, so this planset wasn't read. An owner can raise the ceiling on the AI spend screen and run it again.",
      },
      200,
      cors,
    );
  }

  const catalogHint = `Known catalog types (prefer these typeText values when matching):\n${JSON.stringify(catalog.slice(0, 200))}`;
  let inTokens = 0;
  let outTokens = 0;
  const failedPages: number[] = [];
  const readPage = async (img: { pageNumber: number; dataUrl: string }): Promise<ScheduleRow[]> => {
    const parsed = dataUrlToImage(img.dataUrl);
    if (!parsed) return [];
    // anthropicVisionChat does not retry, and a rate-limited page that
    // silently becomes [] is a silently under-counted planset — the exact
    // failure this read exists to kill. One retry, then the page is
    // REPORTED failed so the client can fall back instead of trusting a
    // partial schedule.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const reply = await anthropicVisionChat({
          system: VISION_SYSTEM,
          text: `${catalogHint}\n\nThis is page ${img.pageNumber}. Apply the rules and return the JSON.`,
          images: [parsed],
          maxTokens: 4096,
          onUsage: (u) => {
            inTokens += u?.inputTokens ?? 0;
            outTokens += u?.outputTokens ?? 0;
          },
        });
        const data = parseJsonLoose(reply) as { rows?: ScheduleRow[] } | null;
        return (data?.rows ?? []).map((r) => ({ ...r, pageNumber: img.pageNumber }));
      } catch (err) {
        console.error("vision page failed", img.pageNumber, "attempt", attempt + 1, err);
        if (attempt === 0) await new Promise((res) => setTimeout(res, 2000));
      }
    }
    failedPages.push(img.pageNumber);
    return [];
  };
  // Three pages at a time: vision-sized payloads burst-fired 24-wide are a
  // rate-limit magnet, and a lost page is lost marks.
  const perPage: ScheduleRow[][] = [];
  for (let i = 0; i < capped.length; i += 3) {
    perPage.push(...(await Promise.all(capped.slice(i, i + 3).map(readPage))));
  }
  if (inTokens === 0 && outTokens === 0) {
    await releaseAiSpend(meter, gate.reservationId, "all_pages_failed", true);
  } else {
    await settleAiSpend(
      meter,
      gate.reservationId,
      { inputTokens: inTokens, outputTokens: outTokens },
      ANTHROPIC_MODEL,
    );
  }
  const rows = cleanAndDedupe(perPage.flat());
  return jsonResponse({ rows, mode: "vision", failed_pages: failedPages }, 200, cors);
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
    // Claude reads the planset text now, so the Anthropic key is the only hard
    // dependency. Fail before any work when it is missing.
    requireAnthropic();
    const body = await req.json();
    const pages = body.pages as { pageNumber: number; text: string }[] | undefined;
    // Page IMAGES make this a vision read (the RAC-OAK-5 lesson, 2026-08-20):
    // cut-sheet plansets carry the truth as PICTURED cells — a drawing plus a
    // QTY field per mark — and the text layer of such a sheet is mostly
    // dimension noise. Text-only reads counted elevation labels ("9" nine
    // times across four elevations became nine openings of mark 9) and
    // missed every mark whose cell text didn't survive PDF text extraction.
    // When the client sends images, ONLY pictured cells count.
    const images = Array.isArray(body.images)
      ? (body.images as { pageNumber: number; dataUrl: string }[]).filter(
          (i) => i && typeof i.dataUrl === "string" && Number.isFinite(Number(i.pageNumber)),
        )
      : [];
    if ((!Array.isArray(pages) || pages.length === 0) && images.length === 0) {
      return jsonResponse({ error: "pages[] or images[] required" }, 400, cors);
    }

    const catalog = Array.isArray(body.catalog)
      ? (body.catalog as { type_code: string; name: string }[])
      : [];

    if (images.length > 0) {
      return await visionScheduleRead(images, catalog, callerId, cors);
    }

    // Big residential/multi-unit plansets used to be silently truncated:
    // each page was cut to 8k chars and the joined doc to 60k, so most of a
    // 100+ opening schedule never reached the model. Instead we keep far more
    // per page and batch pages into several LLM calls, accumulating rows so
    // nothing is dropped.
    const PER_PAGE_LIMIT = 24000;
    const BATCH_CHAR_BUDGET = 90000;
    const MAX_BATCHES = 12;

    const pageBlocks = pages.map(
      (p) =>
        `--- PAGE ${p.pageNumber} ---\n${(p.text ?? "").slice(0, PER_PAGE_LIMIT)}`,
    );

    // Greedily pack page blocks into batches under the char budget. A single
    // page larger than the budget still goes out on its own (already capped).
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
    const limitedBatches = batches.slice(0, MAX_BATCHES);

    const system =
      "Extract window and door schedule rows from construction planset text. Return schedule marks (#14, W1, A-101, etc). Include doors. Each mark has a quantity — read the QTY/quantity column and return it (do not collapse to 1). Prefer typeText from known catalog codes when present. Capture widthIn/heightIn in inches when a size column exists, color when present, and kind window|door.";
    const schema = `Schema: { "rows": [ { "openingCode": string, "typeText": string, "qty": number, "label": string|null, "pageNumber": number, "widthIn": number|null, "heightIn": number|null, "color": string|null, "kind": "window"|"door" } ] }`;
    const catalogHint = `Known catalog types (prefer these typeText values when matching):\n${JSON.stringify(catalog.slice(0, 200))}`;

    // Spend guard, write-time flavour. Reading a planset is owner-triggered,
    // happens once per job rather than once per curiosity, and produces the
    // schedule the whole install runs off — so it carries NO role floor and NO
    // per-user daily count (a 100-opening planset legitimately needs a dozen
    // calls in one go). It is still metered, and it still stops at the company
    // ceiling. The estimate is per batch, because that is what costs money.
    const meter =
      SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
        ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        : null;
    const gate = await reserveAiSpend(meter, {
      userId: callerId,
      functionName: "extract-schedule",
      units: limitedBatches.length,
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
          rows: [],
          limited: true,
          limit_reason: gate.reason,
          note: "The company's monthly AI budget is used up, so this planset wasn't read. An owner can raise the ceiling on the AI spend screen and run it again.",
        },
        200,
        cors,
      );
    }

    let inTokens = 0;
    let outTokens = 0;
    const batchResults = await Promise.all(
      limitedBatches.map((text) =>
        anthropicChatJson<{ rows: ScheduleRow[] }>({
          system,
          user: `${catalogHint}\n\nPlanset text:\n${text}`,
          schemaHint: schema,
          schema: SCHEDULE_SCHEMA,
          onUsage: (u) => {
            inTokens += u.inputTokens ?? 0;
            outTokens += u.outputTokens ?? 0;
          },
        }).catch((err) => {
          console.error("batch failed", err);
          return { rows: [] as ScheduleRow[] };
        }),
      ),
    );

    if (inTokens === 0 && outTokens === 0) {
      // Every batch failed before the provider charged anything.
      await releaseAiSpend(meter, gate.reservationId, "all_batches_failed", true);
    } else {
      await settleAiSpend(
        meter,
        gate.reservationId,
        { inputTokens: inTokens, outputTokens: outTokens },
        ANTHROPIC_MODEL,
      );
    }

    const rows = cleanAndDedupe(batchResults.flatMap((r) => r.rows ?? []));
    return jsonResponse({ rows, mode: "text" }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});
