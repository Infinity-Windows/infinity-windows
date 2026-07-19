import {
  chatJson,
  corsHeaders,
  jsonResponse,
} from "../_shared/openai.ts";
import { requireCaller } from "../_shared/auth.ts";

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

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const unauthorized = await requireCaller(req, cors);
  if (unauthorized) return unauthorized;

  try {
    const body = await req.json();
    const pages = body.pages as { pageNumber: number; text: string }[] | undefined;
    if (!Array.isArray(pages) || pages.length === 0) {
      return jsonResponse({ error: "pages[] required" }, 400, cors);
    }

    const catalog = Array.isArray(body.catalog)
      ? (body.catalog as { type_code: string; name: string }[])
      : [];

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

    const batchResults = await Promise.all(
      limitedBatches.map((text) =>
        chatJson<{ rows: ScheduleRow[] }>(
          system,
          `${catalogHint}\n\nPlanset text:\n${text}`,
          schema,
        ).catch((err) => {
          console.error("batch failed", err);
          return { rows: [] as ScheduleRow[] };
        }),
      ),
    );

    const clean = batchResults
      .flatMap((r) => r.rows ?? [])
      .filter((r) => r && typeof r.openingCode === "string" && r.openingCode.trim())
      .map((r) => ({
        openingCode: String(r.openingCode).trim().replace(/^#/, "").toUpperCase(),
        typeText: String(r.typeText ?? "").trim().toUpperCase() || "UNKNOWN",
        qty: Math.min(500, Math.max(1, Number(r.qty) || 1)),
        label: r.label ? String(r.label).trim() : null,
        pageNumber: Number(r.pageNumber) || 1,
        widthIn: r.widthIn != null && Number.isFinite(Number(r.widthIn)) ? Number(r.widthIn) : null,
        heightIn: r.heightIn != null && Number.isFinite(Number(r.heightIn)) ? Number(r.heightIn) : null,
        color: r.color ? String(r.color).trim().toUpperCase() : null,
        kind: String(r.kind ?? "").toLowerCase() === "door" ? "door" : "window",
      }));

    // Batches can overlap or repeat a mark; keep one row per mark+page and
    // prefer the larger quantity so nothing is under-counted.
    const byKey = new Map<string, (typeof clean)[number]>();
    for (const row of clean) {
      const key = `${row.openingCode}@${row.pageNumber}`;
      const existing = byKey.get(key);
      if (!existing || row.qty > existing.qty) byKey.set(key, row);
    }
    const rows = [...byKey.values()];

    return jsonResponse({ rows }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});
