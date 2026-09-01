#!/usr/bin/env node
// Seed MADMOOSE's Maps Interactive model from a hand-read of the real CADs
// (app/src/lib/fitview/fixtures/madmoose-mm2.json — every cut-sheet cell and
// elevation read whole by Claude, 2026-08-31; the pilot for the
// "work-the-hard-jobs-in-a-session" flow the owner asked for).
//
// What it writes, and ONLY this:
//   1. features.fitview.model on the page-1 outline — the live building
//      (the owner's own trace, interior partition and all) PATCHED to the
//      elevations' true heights, plus all 10 windows placed per the plans.
//   2. project_mark_specs.extra.pane_grid for each mark, FILL-MISSING ONLY
//      (wave-G contract; a grid already present is never overwritten).
//
// What it never touches — different from seed-black22-fitview.mjs, on
// purpose: outline POINTS (they came from tracing the real sheet and align
// the flat map and every confirmed pin), dividers, wallOpenings, the
// modelstudio save, northDeg, the trace itself. The building's footprints
// and stories keep the owner's geometry — only heights are corrected
// (3 m defaults -> 11 ft subfloor / 25 ft parapet, sheet A5).
//
// Modes (safe by default), same as the BLACK22 seed:
//   node scripts/seed-madmoose-fitview.mjs             # plan: local-only
//   node scripts/seed-madmoose-fitview.mjs --dry-run   # + read DB, show diff
//   node scripts/seed-madmoose-fitview.mjs --apply     # write
// --dry-run/--apply need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  patchBuilding,
  mergeMadmooseFeatures,
  extraWithPaneGrid,
} from "./lib/madmoose-seed.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(root, "app/src/lib/fitview/fixtures/madmoose-mm2.json"), "utf8"),
);

const JOB_CODE = "MADMOOSE";
const mode = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--dry-run")
    ? "dry-run"
    : "plan";

const w = fixture.windows;
console.log(`Seed plan for ${JOB_CODE} (${fixture.addr})`);
console.log(`  windows        : ${w.length} hand-placed (marks ${w.map((x) => x.id).join(", ")})`);
console.log(`  wall height    : ${fixture.buildingPatch.height} m (25 ft parapet; trace had 6 m)`);
console.log(`  stories        : subfloor 3.35 m, parapet 7.62 m (trace had 3 m / 3 m)`);
console.log(`  pane grids     : ${Object.keys(fixture.paneGrids).length} marks, fill-missing only`);
console.log(`  never touched  : outline points, trace, interior partition, dividers, modelstudio, northDeg`);

if (mode === "plan") {
  console.log("\nLocal plan only. --dry-run to diff against live, --apply to write.");
  process.exit(0);
}

const { createAdminClient } = await import("./lib/supabase-admin.mjs");
const supabase = createAdminClient();

const { data: projects, error: pErr } = await supabase
  .from("projects").select("id, job_code, name").eq("job_code", JOB_CODE);
if (pErr) throw pErr;
if (!projects?.length) throw new Error(`no project with job_code ${JOB_CODE}`);
const project = projects[0];

const { data: outlines, error: oErr } = await supabase
  .from("project_plan_outlines")
  .select("id, page_number, points, features")
  .eq("project_id", project.id).eq("page_number", 1);
if (oErr) throw oErr;
const target = outlines?.[0];
if (!target?.features?.fitview?.model?.building) {
  throw new Error(
    `${JOB_CODE} has no traced model on page 1 — trace the building in the app first; this seed only adds windows and true heights to an existing trace.`,
  );
}

const liveBuilding = target.features.fitview.model.building;
const patched = patchBuilding(liveBuilding, fixture.buildingPatch);
const features = mergeMadmooseFeatures(
  target.features, patched, fixture.windows, fixture.buildingPatch.wallHeightM,
);

const { data: specs, error: sErr } = await supabase
  .from("project_mark_specs")
  .select("id, mark_code, extra")
  .eq("project_id", project.id);
if (sErr) throw sErr;

const specWrites = [];
for (const [mark, grid] of Object.entries(fixture.paneGrids)) {
  const row = specs?.find((s) => s.mark_code === mark);
  if (!row) { console.log(`  spec ${mark}: no row — skipped`); continue; }
  const next = extraWithPaneGrid(row.extra, grid);
  if (!next) { console.log(`  spec ${mark}: pane_grid already present — left alone`); continue; }
  specWrites.push({ id: row.id, mark, extra: next });
}

console.log(`\nLive: ${project.name} (${project.id})`);
console.log(`  outline ${target.id} page 1: ${target.points?.length ?? 0} pts (untouched), ` +
  `model windows ${target.features.fitview.model.windows?.length ?? 0} -> ${fixture.windows.length}`);
console.log(`  building height ${liveBuilding.height} -> ${patched.height}; ` +
  `stories ${JSON.stringify((liveBuilding.stories ?? []).map((s) => s.heightM))} -> ` +
  `${JSON.stringify((patched.stories ?? []).map((s) => s.heightM))}`);
console.log(`  pane grids to write: ${specWrites.map((x) => x.mark).join(", ") || "none"}`);

if (mode === "dry-run") {
  console.log("\nDry run only — nothing written. Re-run with --apply to write.");
  process.exit(0);
}

const { error: uErr } = await supabase
  .from("project_plan_outlines").update({ features }).eq("id", target.id);
if (uErr) throw uErr;
for (const s of specWrites) {
  const { error } = await supabase
    .from("project_mark_specs").update({ extra: s.extra }).eq("id", s.id);
  if (error) throw error;
}
console.log(`\nApplied: model with ${fixture.windows.length} windows + ${specWrites.length} pane grids.`);
console.log("Open Maps Interactive / Studio for Mad Moose to see it.");
