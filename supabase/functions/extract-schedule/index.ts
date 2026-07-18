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

    const joined = pages
      .map((p) => `--- PAGE ${p.pageNumber} ---\n${(p.text ?? "").slice(0, 8000)}`)
      .join("\n\n")
      .slice(0, 60000);

    const result = await chatJson<{ rows: ScheduleRow[] }>(
      "Extract window and door schedule rows from construction planset text. Return schedule marks (#14, W1, A-101, etc). Include doors. qty defaults to 1. Prefer typeText from known catalog codes when present. Capture widthIn/heightIn in inches when a size column exists, color when present, and kind window|door.",
      `Known catalog types (prefer these typeText values when matching):\n${JSON.stringify(catalog.slice(0, 200))}\n\nPlanset text:\n${joined}`,
      `Schema: { "rows": [ { "openingCode": string, "typeText": string, "qty": number, "label": string|null, "pageNumber": number, "widthIn": number|null, "heightIn": number|null, "color": string|null, "kind": "window"|"door" } ] }`,
    );

    const rows = (result.rows ?? [])
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

    return jsonResponse({ rows }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});
