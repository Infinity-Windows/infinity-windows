#!/usr/bin/env node
// Seed BLACK22's Maps Interactive model from the window-viewer prototype's
// hand-traced Black Desert job (app/src/lib/fitview/fixtures/win-2423.json).
//
// What it writes: ONE row in project_plan_outlines — the traced main footprint
// normalized to page coordinates, with the true scale and wall height carried
// in features.fitview so the adapter stops using its documented defaults.
// It does NOT touch openings, pins, specs, or any other table.
//
// --apply merges onto whatever features the row already carries (wave N):
// a hand-set northDeg or a Plan Model editor divider survives a re-run —
// only fitview.longSideM/wallHeightM/source/model, this script's own
// fields, get overwritten. dividers/wallOpenings still reset to empty on
// every run; this script has never carried those forward.
//
// Known v1 limit: the fixture has a second, smaller footprint polygon; the
// outline table stores one polygon per row and the tab reads one outline, so
// only the main mass is seeded.
//
// Modes (safe by default):
//   node scripts/seed-black22-fitview.mjs             # plan: local-only, no DB
//   node scripts/seed-black22-fitview.mjs --dry-run   # + read DB, show the diff
//   node scripts/seed-black22-fitview.mjs --apply     # write, after a dry-run
//
// --dry-run/--apply need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, same as
// the other scripts here (see scripts/lib/supabase-admin.mjs).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeFitviewSeed } from "./lib/fitview-seed.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(root, "app/src/lib/fitview/fixtures/win-2423.json"), "utf8"),
);

const JOB_CODE = "BLACK22";
const mode = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--dry-run")
    ? "dry-run"
    : "plan";

// ---- build the outline row from the fixture (pure) ----
const foot = fixture.building.footprints[0];
if (!foot || foot.length < 3) throw new Error("fixture has no main footprint");

const xs = foot.map((p) => p.x);
const zs = foot.map((p) => p.z);
const minX = Math.min(...xs), maxX = Math.max(...xs);
const minZ = Math.min(...zs), maxZ = Math.max(...zs);
const spanX = maxX - minX, spanZ = maxZ - minZ;
const longSideM = Math.max(spanX, spanZ);

// Fit the footprint into the middle 80% of a square page, proportions kept.
const s = 0.8 / longSideM;
const points = foot.map((p) => ({
  x: +(0.1 + (p.x - minX) * s).toFixed(5),
  y: +(0.1 + (p.z - minZ) * s).toFixed(5),
}));

// The COMPLETE survey model rides along: both footprint masses with their
// named walls, every window exactly where the surveyor placed it (elev,
// metres along the wall, sill height, panels, corner wraps) — AND the raw
// `trace` (plan-pixel polygons, dots, calibration), which is what lets the
// in-app tracer restore Ben's outline editable instead of starting over.
// mergeFitviewSeed (scripts/lib/fitview-seed.mjs, pure and tested there) is
// what protects a key this script doesn't know about — wave N's northDeg —
// from a blind overwrite on a later --apply.

// Local-plan preview (no DB yet): nothing to merge against.
const features = mergeFitviewSeed(
  null,
  longSideM,
  fixture.building.height,
  fixture.building,
  fixture.windows,
);

console.log(`Seed plan for ${JOB_CODE} (${fixture.addr || fixture.ref})`);
console.log(`  outline points     : ${points.length} (main mass; for the flat plan editor)`);
console.log(`  full model         : ${fixture.building.footprints.length} masses, ` +
  `${fixture.windows.length} surveyor-placed windows, named walls — carried in features.fitview.model`);
console.log(`  true long side     : ${longSideM.toFixed(1)} m (adapter default would be 30 m)`);
console.log(`  wall height        : ${fixture.building.height} m (default 3.6 m)`);

if (mode === "plan") {
  console.log("\nLocal plan only. Re-run with --dry-run to diff against the live");
  console.log("database, then --apply to write the outline row.");
  process.exit(0);
}

// ---- live modes ----
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
  .from("projects").select("id, job_code, name").eq("job_code", JOB_CODE);
if (pErr) throw pErr;
if (!projects?.length) throw new Error(`no project with job_code ${JOB_CODE}`);
const project = projects[0];

const { data: plansets, error: psErr } = await supabase
  .from("plansets").select("id, kind, status, created_at")
  .eq("project_id", project.id).order("created_at");
if (psErr) throw psErr;
const plans = plansets?.find((p) => p.kind === "plans") ?? plansets?.[0];
if (!plans) throw new Error(`${JOB_CODE} has no planset to attach the outline to`);

const { data: existing, error: oErr } = await supabase
  .from("project_plan_outlines").select("id, page_number, points, features")
  .eq("project_id", project.id);
if (oErr) throw oErr;

console.log(`\nLive state:`);
console.log(`  project  : ${project.name} (${project.id})`);
console.log(`  planset  : ${plans.id} (${plans.kind})`);
for (const row of existing ?? []) {
  const cal = row.features?.fitview;
  console.log(
    `  outline  : page ${row.page_number}, ${row.points?.length ?? 0} pts` +
      (cal ? `, calibrated ${cal.longSideM}m` : ", uncalibrated"),
  );
}
if (!existing?.length) console.log("  outline  : none yet");

const target = existing?.find((r) => r.page_number === 1);
const action = target
  ? `UPDATE outline ${target.id} (page 1): ${target.points?.length ?? 0} pts -> ${points.length} pts + calibration`
  : `INSERT outline on page 1 of planset ${plans.id}: ${points.length} pts + calibration`;
console.log(`\nWould ${mode === "apply" ? "now" : ""} ${action}`);

if (mode === "dry-run") {
  console.log("\nDry run only — nothing written. Re-run with --apply to write.");
  process.exit(0);
}

// Re-merge against the LIVE row, not the local preview above: an --apply
// against a job whose outline has moved on since (a hand-set northDeg, a
// divider drawn in the Plan Model editor) must carry that forward, not the
// blind overwrite this script used to do.
const liveFeatures = mergeFitviewSeed(
  target?.features ?? null,
  longSideM,
  fixture.building.height,
  fixture.building,
  fixture.windows,
);
const values = {
  project_id: project.id,
  planset_id: plans.id,
  page_number: 1,
  points,
  page_aspect: 1,
  features: liveFeatures,
};
const q = target
  ? supabase.from("project_plan_outlines").update(values).eq("id", target.id)
  : supabase.from("project_plan_outlines").insert(values);
const { error: wErr } = await q;
if (wErr) throw wErr;
console.log("Written. Open BLACK22 -> Maps Interactive to see the model.");
