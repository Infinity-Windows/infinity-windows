#!/usr/bin/env node
// Weekly inventory health report. Queries Supabase and writes a markdown
// report into the vault so the AI brain (and humans) can read warehouse state.
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/weekly-report.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminClient } from "./lib/supabase-admin.mjs";
import {
  explainError,
  publishableKeyRefusal,
  readCredential,
} from "./lib/supabase-key.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { value: url } = readCredential(process.env.SUPABASE_URL);
const { value: key } = readCredential(process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const refusal = publishableKeyRefusal(key);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}
const supabase = createAdminClient(url, key);

const [windows, counts, projects] = await Promise.all([
  supabase
    .from("windows")
    .select("window_id, status, received_at, window_types(type_code, name), locations(address), projects(job_code)"),
  supabase
    .from("cycle_counts")
    .select("*, locations(address)")
    .gte("started_at", new Date(Date.now() - 7 * 864e5).toISOString()),
  supabase
    .from("projects")
    .select("id, job_code, name, project_windows(quantity, window_type_id)")
    .eq("status", "active"),
]);

for (const r of [windows, counts, projects]) {
  if (r.error) {
    console.error(explainError(r.error.message, { url, key }));
    process.exit(1);
  }
}

const units = windows.data;
const inbound = units.filter((w) => w.status === "inbound");
const damaged = units.filter((w) => w.status === "damaged");
const staleCutoff = Date.now() - 90 * 864e5;
const stale = units.filter(
  (w) =>
    w.status === "in_warehouse" &&
    !w.projects &&
    new Date(w.received_at).getTime() < staleCutoff,
);

const discrepancies = counts.data.flatMap((c) =>
  (c.discrepancies ?? []).map((d) => ({ ...d, address: c.locations?.address })),
);

const shortJobs = projects.data
  .map((p) => {
    const needed = p.project_windows.reduce((s, n) => s + n.quantity, 0);
    const have = units.filter(
      (w) => w.projects?.job_code === p.job_code && w.status !== "installed",
    ).length;
    const installed = units.filter(
      (w) => w.projects?.job_code === p.job_code && w.status === "installed",
    ).length;
    return { job: p.job_code, name: p.name, needed, have, installed };
  })
  .filter((j) => j.have + j.installed < j.needed);

const today = new Date().toISOString().slice(0, 10);
const lines = [
  `# Warehouse report — ${today}`,
  "",
  `- Windows on hand: ${units.filter((w) => !["installed", "loaded"].includes(w.status)).length}`,
  `- Awaiting putaway: ${inbound.length}`,
  `- Damaged/hold: ${damaged.length}`,
  `- Cycle counts this week: ${counts.data.length} (${discrepancies.length} discrepancies)`,
  "",
  "## Needs attention",
  "",
];

if (inbound.length) {
  lines.push("### Windows never put away");
  for (const w of inbound) lines.push(`- ${w.window_id} (${w.window_types?.name})`);
  lines.push("");
}
if (discrepancies.length) {
  lines.push("### Cycle count discrepancies");
  for (const d of discrepancies)
    lines.push(`- ${d.window_id}: ${d.issue} at ${d.address}`);
  lines.push("");
}
if (shortJobs.length) {
  lines.push("### Jobs short on windows");
  for (const j of shortJobs)
    lines.push(`- ${j.job}: has ${j.have + j.installed}/${j.needed} (${j.name})`);
  lines.push("");
}
if (stale.length) {
  lines.push("### Stale stock (unassigned > 90 days)");
  for (const w of stale)
    lines.push(`- ${w.window_id} at ${w.locations?.address ?? "?"} since ${w.received_at.slice(0, 10)}`);
  lines.push("");
}
if (!inbound.length && !discrepancies.length && !shortJobs.length && !stale.length) {
  lines.push("Nothing. Warehouse is clean.");
}

const outDir = join(root, "vault", "reports");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `warehouse-${today}.md`);
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`Wrote ${outPath}`);
