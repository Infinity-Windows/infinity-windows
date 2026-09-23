#!/usr/bin/env node
// Check a reviewed "Using Forge" walkthrough package BEFORE it goes near the
// app: the role floors, proposal status, file paths and types, sizes, chapter
// and caption timing, the transcript JSON, and no contact details. Runbook:
// docs/role-training-videos.md. Rules: scripts/lib/role-walkthroughs.mjs.
//
//   node scripts/publish-role-walkthroughs.mjs --manifest <package>/role-videos-manifest.json
//
// VALIDATION ONLY. It reads no credentials, makes no network call and writes
// nothing. Publishing is done by a supervisor or owner through the in-app
// importer, whose server functions re-check everything and switch versions
// over in ONE transaction. An earlier service-key --apply path switched the
// old version off and the new one on in separate calls — a failure between
// them left no walkthrough live — so it was retired rather than kept as a
// second, weaker way in.
//
// Options: --version N (used only when an entry has no `version` of its own).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BUCKET, validateManifest } from "./lib/role-walkthroughs.mjs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("--apply")) {
  console.error(
    "--apply is retired: this script only validates. Publish from the app's walkthrough importer " +
      "(supervisor or owner), which checks and switches versions over atomically. Nothing was uploaded.",
  );
  process.exit(2);
}

const manifestPath = arg("--manifest");
if (!manifestPath) {
  console.error("Usage: node scripts/publish-role-walkthroughs.mjs --manifest <role-videos-manifest.json> [--version N]");
  process.exit(2);
}
const versionArg = arg("--version");
const version = versionArg === undefined ? 1 : Number(versionArg);

let manifest;
try {
  manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
} catch (err) {
  console.error(`Could not read the manifest: ${err instanceof Error ? err.message : "unreadable"}`);
  process.exit(1);
}

const { errors, plan } = validateManifest(manifest, { baseDir: dirname(resolve(manifestPath)), version });
if (errors.length) {
  console.error(`Package refused — ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`Package OK: ${plan.length} walkthrough(s) for private bucket '${BUCKET}'`);
for (const p of plan) {
  const r = p.row;
  const statuses = r.chapters.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {});
  console.log(`\n  ${r.slug}  (floor: ${r.min_role}, v${r.version}, ${r.language}, ${r.duration_seconds}s, ${r.content_status})`);
  console.log(`    title       : ${r.title}`);
  console.log(`    chapters    : ${r.chapters.length} — ${Object.entries(statuses).map(([k, n]) => `${n} ${k}`).join(", ")}`);
  console.log(`    transcript  : ${r.transcript_text.length} characters, ${r.transcript_text.split("\n\n").length} paragraph(s)`);
  for (const u of p.uploads) console.log(`    file        : ${u.rel} → ${u.object} (${mb(u.size)}, ${u.contentType})`);
}
console.log("\nValidation only — nothing was read from or written to Supabase. Publish through the in-app importer.");
