#!/usr/bin/env node
// Give MADMOOSE's marks their cut-sheet drawings and line items back after the
// 2026-09-01 18:24 addendum upload (the incident the vision-first and
// per-document rules were written for; this is the data half of that fix).
//
// What happened, in order:
//   1. An addendum cut sheet (specs planset, file name containing "MMV2A_-_C",
//      one page) was extracted before the mark-prefix fix landed, so its three
//      units "Add-1/2/3" were read as marks "1/2/3" and UPSERTED over the job's
//      real rows 1, 2 and 3 — size, style, glass, color, operation, tempered,
//      printed sizes, panels, planset and drawing box all replaced. Only
//      `pane_grid` survived, because the extractor fills that key just once.
//   2. The same upload's "retire replaced planset" step then nulled
//      image_page/image_bbox on marks 4-10, whose drawings live on the ORIGINAL
//      cut sheet (file name containing "MMV2_-_CU", four pages) — it knew only
//      about one specs sheet per job, and this job carries two.
//   3. Rows Add-1/2/3 were later typed by hand: right words, no numbers, no
//      drawing.
//
// What this writes, and only this:
//   A. marks 1/2/3 — the cut sheet's line items, but ONLY while the row still
//      carries the addendum's width and is not confirmed (see planSpecRestore).
//   B. marks 1-10 — planset_id/image_page/image_bbox on the cut sheet.
//   C. Add-1/2/3 — the addendum sheet's drawing plus the printed sizes and
//      panel splits they never got, fill-missing only.
// It never touches openings, pins, pane_grid, or any row it wasn't asked about,
// and it never invents a planset id: both sheets are resolved at run time from
// project_plansets.storage_path.
//
// Why every write below names a sheet: the app resolves a drawing's file PER
// SPEC (`findSpecsPlansetFor`, app/src/lib/install/api.ts, PR #496). A spec
// that names a specs planset the project still has is drawn from exactly that
// file, so marks 1-10 render off the cut sheet and the Adds off the addendum on
// the same card; `isDrawingStale` hides a drawing only when its sheet is GONE
// from the job. A spec with a NULL planset_id draws nothing at all on a job
// carrying two specs sheets — guessing between them is what took these pictures
// away in the first place — which is why planDrawingWrites always writes
// planset_id alongside the page and the box, never a box on its own.
//
// Modes (safe by default), same as the other Mad Moose seeds:
//   node scripts/seed-madmoose-specs-repair.mjs            # plan: local only
//   node scripts/seed-madmoose-specs-repair.mjs --dry-run  # + read DB, show diff
//   node scripts/seed-madmoose-specs-repair.mjs --apply    # write
// --dry-run/--apply need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the "Run
// seed script" workflow holds both; nobody's laptop needs the service key).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDrawingTable,
  checkLiveSheet,
  mergeRowPatches,
  planAddFill,
  planDrawingWrites,
  planSpecRestore,
  resolveSpecPlansets,
} from "./lib/madmoose-specs-repair.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(root, "app/src/lib/fitview/fixtures/madmoose-mm2.json"), "utf8"),
);

const PROJECT = "08c60cce-29f6-4b52-bd0c-2bc2c02a79a9";
const sheets = fixture.specPlansets;
const drawings = fixture.specDrawings;
const restore = fixture.specRestore.marks;
const addFill = fixture.specAddFill.marks;

const mode = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--dry-run")
    ? "dry-run"
    : "plan";

// Check the paper before the database: a mistyped corner or two marks claiming
// the same patch of a page hands a crew a picture of the wrong window, and that
// is worth refusing over rather than writing and apologising for.
const paperProblems = [
  ...checkDrawingTable(drawings.cu, sheets.cu.pages).map((p) => `cut sheet: ${p}`),
  ...checkDrawingTable(drawings.addendum, sheets.addendum.pages).map((p) => `addendum: ${p}`),
];
if (paperProblems.length) {
  console.error("The drawing table in madmoose-mm2.json is wrong — nothing was written:");
  for (const p of paperProblems) console.error(`  ${p}`);
  process.exit(1);
}

console.log("Repair plan for MADMOOSE mark specs");
console.log(`  cut sheet      : file name contains "${sheets.cu.pathFragment}" (${sheets.cu.label})`);
console.log(`  addendum       : file name contains "${sheets.addendum.pathFragment}" (${sheets.addendum.label})`);
console.log(`  restore text   : marks ${Object.keys(restore).join(", ")} — only while a row still reads ` +
  `${Object.values(restore).map((r) => r.addendumWidthIn).join(" / ")} in wide and is unconfirmed`);
console.log(`  cut-sheet art  : marks ${Object.keys(drawings.cu).join(", ")} ` +
  `(pages ${[...new Set(Object.values(drawings.cu).map((d) => d.page))].sort().join(", ")})`);
console.log(`  addendum art   : ${Object.keys(drawings.addendum).join(", ")} + their printed sizes and panels, fill-missing`);
console.log("  never touched  : openings, pins, pane_grid, confirmed line items");

if (mode === "plan") {
  console.log("\nLocal plan only. --dry-run to diff against live, --apply to write.");
  process.exit(0);
}

const { createAdminClient } = await import("./lib/supabase-admin.mjs");
const { readCredential } = await import("./lib/supabase-key.mjs");
const { value: dbUrl } = readCredential(process.env.SUPABASE_URL);
const { value: dbKey } = readCredential(process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!dbUrl || !dbKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createAdminClient(dbUrl, dbKey);

const { data: projects, error: pErr } = await supabase
  .from("projects").select("id, job_code, name").eq("id", PROJECT);
if (pErr) throw pErr;
const project = projects?.[0];
if (!project) throw new Error(`no project ${PROJECT} — wrong database?`);

const { data: plansetRows, error: plErr } = await supabase
  .from("project_plansets")
  .select("id, storage_path, kind, page_count, converted_pdf_path, source_format, created_at")
  .eq("project_id", PROJECT);
if (plErr) throw plErr;
// A missing or ambiguous sheet is a refusal. It is also the likeliest reason
// this ever stops, so it prints the sentence and not a stack trace — whoever
// runs this is reading an Actions log, not debugging Node.
let cu, addendum;
try {
  ({ cu, addendum } = resolveSpecPlansets(plansetRows, sheets));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// The paper check above can only hold the fixture to itself. Now that the two
// rows are in hand, hold them to the sheets the boxes were actually read off: a
// different edition uploaded under the same name is the one way this writes a
// page number that lands on a different unit, or on no page at all.
const sheetProblems = [
  ...checkLiveSheet("cut sheet", cu, sheets.cu),
  ...checkLiveSheet("addendum", addendum, sheets.addendum),
];
if (sheetProblems.length) {
  console.error("The sheets on this job are not the ones these boxes were read off — nothing was written:");
  for (const p of sheetProblems) console.error(`  ${p}`);
  process.exit(1);
}

// Explicit columns, never select("*") — house rule, and these are all the
// fields any rule below reads or writes.
const { data: specs, error: sErr } = await supabase
  .from("project_mark_specs")
  .select("id, mark_code, planset_id, image_page, image_bbox, width_in, height_in, tempered, confirmed, source, extra")
  .eq("project_id", PROJECT);
if (sErr) throw sErr;

const restorePlan = planSpecRestore(specs, restore);
const cuDrawingPlan = planDrawingWrites(specs, drawings.cu, cu.id, { fixWrongSheet: true });
const addDrawingPlan = planDrawingWrites(specs, drawings.addendum, addendum.id);
const addFillPlan = planAddFill(specs, addFill);
const writes = mergeRowPatches([restorePlan, cuDrawingPlan, addDrawingPlan, addFillPlan]);

const pages = (n) => (n == null ? "? pages" : `${n} page${n === 1 ? "" : "s"}`);
console.log(`\nLive: ${project.name} (${project.job_code})`);
console.log(`  cut sheet ${cu.id} — ${pages(cu.page_count)}, kind ${cu.kind}`);
console.log(`  addendum  ${addendum.id} — ${pages(addendum.page_count)}, kind ${addendum.kind}`);
console.log(`  spec rows : ${specs?.length ?? 0}`);

const show = (title, plan) => {
  console.log(`\n  ${title}`);
  for (const d of plan) console.log(`    ${d.mark.padEnd(6)} ${d.action.padEnd(11)} ${d.why}`);
};
show("line items (marks 1-3):", restorePlan);
show("drawings on the cut sheet:", cuDrawingPlan);
show("drawings on the addendum:", addDrawingPlan);
show("printed sizes for the Adds:", addFillPlan);
console.log(`\n  rows to update: ${writes.length} (${writes.map((w) => w.mark).join(", ") || "none — everything is already right"})`);

if (mode === "dry-run") {
  console.log("\nDry run only — nothing written. Re-run with --apply to write.");
  process.exit(0);
}

for (const w of writes) {
  // Scoped to the project as well as the row id. The ids came from a
  // project-scoped read a moment ago, so this can only ever be redundant — but
  // it runs with the service key, where redundant is the right price for
  // "cannot touch another job".
  const { error } = await supabase
    .from("project_mark_specs").update(w.patch).eq("id", w.id).eq("project_id", PROJECT);
  if (error) throw error;
}
console.log(`\nApplied: ${writes.length} rows updated. Run again — it should report nothing left to do.`);
