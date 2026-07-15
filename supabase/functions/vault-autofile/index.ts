import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";

const GITHUB_TOKEN = Deno.env.get("GITHUB_VAULT_TOKEN") ?? "";
const GITHUB_REPO = Deno.env.get("GITHUB_VAULT_REPO") ?? "taylorhorizon/window-ops-app";
const GITHUB_BRANCH = Deno.env.get("GITHUB_VAULT_BRANCH") ?? "master";

const TOPICS: [string, string][] = [
  ["difficulty", "Difficulty / how it felt"],
  ["went_well", "What went well"],
  ["went_poorly", "What didn't go well"],
  ["obstacles", "Obstacles"],
  ["tools_helped", "Tools / materials that helped"],
  ["time_vs_estimate", "Time estimate vs actual"],
  ["safety_notes", "Safety notes"],
  ["do_again", "What we'd do again next time"],
];

function encodeBase64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}

async function commitFile(path: string, content: string, message: string) {
  if (!GITHUB_TOKEN) throw new Error("GITHUB_VAULT_TOKEN secret is not set");

  const api = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Idempotent: skip if file already exists.
  const existing = await fetch(`${api}?ref=${GITHUB_BRANCH}`, { headers });
  if (existing.status === 200) {
    return { skipped: true, path };
  }

  const res = await fetch(api, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message,
      content: encodeBase64(content),
      branch: GITHUB_BRANCH,
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub commit failed: ${res.status} ${await res.text()}`);
  }
  return { skipped: false, path };
}

function buildMemoMarkdown(e: Record<string, unknown>): string {
  const type = e.window_types as { type_code?: string; name?: string } | null;
  const opening = e.project_openings as {
    opening_code?: string;
    label?: string;
    projects?: { job_code?: string; name?: string };
  } | null;
  const unit = e.windows as { window_id?: string } | null;
  const typeCode = type?.type_code ?? "UNKNOWN-TYPE";
  const openingCode = opening?.opening_code ?? String(e.id).slice(0, 8);
  const date = String(e.created_at).slice(0, 10);
  const project = opening?.projects;

  const lines = [
    `# Install memo — ${typeCode} @ ${openingCode}`,
    "",
    `- Date: ${date}`,
    `- Job: ${project ? `${project.job_code} (${project.name})` : "?"}`,
    `- Opening: ${openingCode}${opening?.label ? ` — ${opening.label}` : ""}`,
    `- Unit: ${unit?.window_id ?? "not tracked"}`,
    `- Installer: ${e.installer ?? "?"}`,
    `- Minutes: ${e.minutes ?? "?"}`,
    `- Quality grade: ${e.quality_grade ?? "?"}/5`,
    "",
  ];
  for (const [field, heading] of TOPICS) {
    if (e[field]) {
      lines.push(`## ${heading}`, "", String(e[field]), "");
    }
  }
  if (e.transcript_raw) {
    lines.push("## Raw transcript", "", String(e.transcript_raw), "");
  }
  return lines.join("\n");
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const record = body.record ?? body;
    const eventId =
      record?.id ??
      record?.install_event_id ??
      body.install_event_id ??
      null;

    let query = supabase
      .from("install_events")
      .select(
        "*, window_types(type_code, name), project_openings(opening_code, label, projects(job_code, name)), windows(window_id)",
      );
    if (eventId) query = query.eq("id", eventId);
    else query = query.order("created_at", { ascending: false }).limit(20);

    const { data: events, error } = await query;
    if (error) throw error;

    const written: string[] = [];
    const skipped: string[] = [];
    for (const e of events ?? []) {
      const typeCode = e.window_types?.type_code ?? "UNKNOWN-TYPE";
      const openingCode = e.project_openings?.opening_code ?? e.id.slice(0, 8);
      const date = e.created_at.slice(0, 10);
      const safeOpening = openingCode.replace(/[^\w-]+/g, "_");
      const path = `vault/windows/${typeCode}/install-memos/${date}-${safeOpening}.md`;
      const md = buildMemoMarkdown(e);
      const result = await commitFile(
        path,
        md,
        `vault: install memo ${typeCode} @ ${openingCode}`,
      );
      if (result.skipped) skipped.push(path);
      else written.push(path);
    }

    return jsonResponse({ ok: true, written, skipped }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});
