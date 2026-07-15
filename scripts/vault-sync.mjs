#!/usr/bin/env node
// Mirror install memos from Supabase into the Obsidian vault. The database
// stays the system of truth; this writes one markdown file per install event
// under vault/windows/<type_code>/install-memos/<date>-<opening_code>.md.
// Idempotent: existing files are never overwritten.
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/vault-sync.mjs

import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(url, key);

// Order matches vault/_schemas/install-memo-topics.md.
const TOPICS = [
  ["difficulty", "Difficulty / how it felt"],
  ["went_well", "What went well"],
  ["went_poorly", "What didn't go well"],
  ["obstacles", "Obstacles"],
  ["tools_helped", "Tools / materials that helped"],
  ["time_vs_estimate", "Time estimate vs actual"],
  ["safety_notes", "Safety notes"],
  ["do_again", "What we'd do again next time"],
];

const { data: events, error } = await supabase
  .from("install_events")
  .select(
    "*, window_types(type_code, name), project_openings(opening_code, label, projects(job_code, name)), windows(window_id)",
  )
  .order("created_at", { ascending: true });
if (error) {
  console.error(error.message);
  process.exit(1);
}

let written = 0;
for (const e of events) {
  const typeCode = e.window_types?.type_code ?? "UNKNOWN-TYPE";
  const openingCode = e.project_openings?.opening_code ?? e.id.slice(0, 8);
  const date = e.created_at.slice(0, 10);
  const dir = join(root, "vault", "windows", typeCode, "install-memos");
  const file = join(dir, `${date}-${openingCode.replace(/[^\w-]+/g, "_")}.md`);
  if (existsSync(file)) continue;

  const project = e.project_openings?.projects;
  const lines = [
    `# Install memo — ${typeCode} @ ${openingCode}`,
    "",
    `- Date: ${date}`,
    `- Job: ${project ? `${project.job_code} (${project.name})` : "?"}`,
    `- Opening: ${openingCode}${e.project_openings?.label ? ` — ${e.project_openings.label}` : ""}`,
    `- Unit: ${e.windows?.window_id ?? "not tracked"}`,
    `- Installer: ${e.installer ?? "?"}`,
    `- Minutes: ${e.minutes ?? "?"}`,
    `- Quality grade: ${e.quality_grade ?? "?"}/5`,
    "",
  ];
  for (const [field, heading] of TOPICS) {
    if (e[field]) {
      lines.push(`## ${heading}`, "", e[field], "");
    }
  }
  if (e.transcript_raw) {
    lines.push("## Raw transcript", "", e.transcript_raw, "");
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, lines.join("\n"));
  written++;
}

console.log(`Synced ${written} new install memo(s) (${events.length} total in DB).`);
