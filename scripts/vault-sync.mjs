#!/usr/bin/env node
// Mirror the install brain from Supabase into the Obsidian vault. The database
// stays the system of truth (DB = truth, vault = wiki); this emits, one-way:
//   1. vault/windows/<type_code>/install-memos/<date>-<opening_code>.md
//      — one per install event, NEVER overwritten (raw field record).
//   2. vault/windows/<type_code>/_profile.md
//      — the current brain card for the type (specs, difficulty, median time,
//        tips, watch-outs, tutorial). Regenerated every run from the DB.
//   3. vault/synthesized/tips.md and pitfalls.md
//      — the whole catalog's tips / watch-outs digest, regenerated every run.
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
    "*, window_types!install_events_window_type_id_fkey(type_code, name), project_openings(opening_code, label, projects(job_code, name)), windows(window_id)",
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

// --- Per-type profiles + synthesized digests (regenerated every run) ---------

const memoCountByType = new Map();
for (const e of events) {
  const code = e.window_types?.type_code;
  if (code) memoCountByType.set(code, (memoCountByType.get(code) ?? 0) + 1);
}

const { data: types, error: typesErr } = await supabase
  .from("window_types")
  .select(
    "type_code, name, category, width_in, height_in, difficulty_rating, learned_difficulty, median_minutes, p90_minutes, avg_grade, fail_rate, n_installs, last_install_at, tutorial_url, tips_json, watch_outs_json, provisional",
  )
  .eq("provisional", false)
  .order("type_code", { ascending: true });
if (typesErr) {
  console.error(typesErr.message);
  process.exit(1);
}

const asList = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v == null ? null : Math.round(Number(v)));

let profiles = 0;
for (const t of types) {
  const size =
    t.width_in && t.height_in ? `${t.width_in}×${t.height_in} in` : "—";
  const tips = asList(t.tips_json);
  const watch = asList(t.watch_outs_json);
  const memoCount = memoCountByType.get(t.type_code) ?? 0;

  const lines = [
    `# ${t.name} (${t.type_code})`,
    "",
    `- Category: ${t.category ?? "—"}`,
    `- Size: ${size}`,
    `- Crew difficulty: ${t.difficulty_rating ?? "—"}/5`,
    `- Learned difficulty: ${t.learned_difficulty != null ? `${Number(t.learned_difficulty).toFixed(1)}/5` : "—"} (from ${t.n_installs ?? 0} installs)`,
    `- Median time: ${num(t.median_minutes) != null ? `${num(t.median_minutes)} min` : "—"}${num(t.p90_minutes) != null ? ` (p90 ${num(t.p90_minutes)} min)` : ""}`,
    `- Avg quality grade: ${t.avg_grade != null ? `${Number(t.avg_grade).toFixed(1)}/5` : "—"}`,
    `- Fail rate: ${t.fail_rate != null ? `${t.fail_rate}%` : "—"}`,
    `- Last install: ${t.last_install_at ? t.last_install_at.slice(0, 10) : "—"}`,
    `- Tutorial: ${t.tutorial_url ? t.tutorial_url : "—"}`,
    "",
    "## Tips",
    "",
    ...(tips.length ? tips.map((x) => `- ${x}`) : ["_No tips saved yet._"]),
    "",
    "## Watch-outs",
    "",
    ...(watch.length ? watch.map((x) => `- ${x}`) : ["_No watch-outs saved yet._"]),
    "",
    "## Install memos",
    "",
    memoCount > 0
      ? `${memoCount} memo(s) — see [[install-memos]] in this folder.`
      : "_No install memos yet._",
    "",
    "---",
    "_Generated from Supabase by scripts/vault-sync.mjs — do not edit by hand._",
    "",
  ];

  const dir = join(root, "vault", "windows", t.type_code);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "_profile.md"), lines.join("\n"));
  profiles++;
}

// Synthesized digests across the whole catalog.
const withTips = types.filter((t) => asList(t.tips_json).length > 0);
const withWatch = types.filter((t) => asList(t.watch_outs_json).length > 0);

const digest = (title, rows, field) => {
  const out = [
    `# ${title}`,
    "",
    "_Generated from Supabase by scripts/vault-sync.mjs — do not edit by hand._",
    "",
  ];
  if (rows.length === 0) {
    out.push("_Nothing yet — this fills in as the brain learns._", "");
    return out.join("\n");
  }
  for (const t of rows) {
    out.push(`## ${t.name} (${t.type_code})`, "");
    for (const x of asList(t[field])) out.push(`- ${x}`);
    out.push("");
  }
  return out.join("\n");
};

const synthDir = join(root, "vault", "synthesized");
mkdirSync(synthDir, { recursive: true });
writeFileSync(join(synthDir, "tips.md"), digest("Install tips (all types)", withTips, "tips_json"));
writeFileSync(
  join(synthDir, "pitfalls.md"),
  digest("Watch-outs & pitfalls (all types)", withWatch, "watch_outs_json"),
);

console.log(
  `Wrote ${profiles} type profile(s) + synthesized tips/pitfalls for ${types.length} catalog type(s).`,
);
