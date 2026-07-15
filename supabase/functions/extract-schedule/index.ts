import {
  chatJson,
  corsHeaders,
  jsonResponse,
} from "../_shared/openai.ts";

interface ScheduleRow {
  openingCode: string;
  typeText: string;
  qty: number;
  label: string | null;
  pageNumber: number;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

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
      "Extract window schedule rows from construction planset text. Only return openings that look like schedule marks (W1, A-101, etc). Ignore doors, notes, and compliance sentences. qty defaults to 1.",
      `Known catalog types (prefer these typeText values when matching):\n${JSON.stringify(catalog.slice(0, 200))}\n\nPlanset text:\n${joined}`,
      `Schema: { "rows": [ { "openingCode": string, "typeText": string, "qty": number, "label": string|null, "pageNumber": number } ] }`,
    );

    const rows = (result.rows ?? [])
      .filter((r) => r && typeof r.openingCode === "string" && r.openingCode.trim())
      .map((r) => ({
        openingCode: String(r.openingCode).trim().toUpperCase(),
        typeText: String(r.typeText ?? "").trim().toUpperCase() || "UNKNOWN",
        qty: Math.min(500, Math.max(1, Number(r.qty) || 1)),
        label: r.label ? String(r.label).trim() : null,
        pageNumber: Number(r.pageNumber) || 1,
      }));

    return jsonResponse({ rows }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});
