#!/usr/bin/env node
// Fill in what kind of unit every mark spec already on the database describes:
// project_mark_specs.unit_kind ("window" / "door") and .door_kind ("slider",
// "french", "bifold", "swing", "other"), the two columns 20260980000000 added.
//
// WHY A BACKFILL AT ALL. Those columns are stored, not derived: the job card
// asks the database "how many doors does this job have?" in one grouped query
// instead of pulling every opening row down to a phone. The app fills them in
// as it writes, so every spec written from the migration onwards is right — and
// every spec written BEFORE it is blank. This is the one run that catches the
// history up. Until it has run, jobs read as "40 openings" with no breakdown,
// which is exactly what they read before wave X: nothing breaks, nothing lies.
//
// It classifies with the SAME function the app writes with
// (app/src/lib/install/specKinds.mjs — plain JavaScript precisely so this
// script can import it). If the rules there ever change, run this again: the
// stored value is a photograph of what the classifier said the day the row was
// written, and an edited rule leaves the old photographs stale.
//
// Every job, every row. There is no reason to do one job: the columns are empty
// everywhere and the classification is a pure reading of text the row already
// carries.
//
// Modes (safe by default), same as the other seeds:
//   node scripts/seed-spec-kinds.mjs            # explain, touch nothing
//   node scripts/seed-spec-kinds.mjs --dry-run  # read the DB, show the counts
//   node scripts/seed-spec-kinds.mjs --apply    # write
// --dry-run/--apply need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Run it
// from Actions → "Run seed script" → spec-kinds, which already holds both;
// nobody's laptop needs the service key.

import {
  batchSpecKindWrites,
  describeDoors,
  planSpecKinds,
} from "./lib/spec-kinds-seed.mjs";

const mode = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--dry-run")
    ? "dry-run"
    : "plan";

console.log("Backfill: what kind of unit is each mark spec?");
console.log("  reads   : project_mark_specs.style and .operation, every job");
console.log("  writes  : unit_kind and door_kind on the rows that disagree");
console.log("  rule    : app/src/lib/install/specKinds.mjs — the app's own classifier");
console.log("  touches : nothing else. Not the spec text, not openings, not confirmed.");

if (mode === "plan") {
  console.log("\nExplanation only. --dry-run to count against live, --apply to write.");
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

// Explicit columns, never select("*") — house rule, and these six are every
// field this reads or writes.
const PAGE = 1000;
const rows = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase
    .from("project_mark_specs")
    .select("id, project_id, mark_code, style, operation, unit_kind, door_kind")
    .order("id", { ascending: true })
    .range(from, from + PAGE - 1);
  if (error) {
    // The likeliest reason this ever stops is being pointed at a database that
    // has not had 20260980000000 yet. Say so in a sentence; whoever runs this
    // is reading an Actions log, not a stack trace.
    if (`${error.message}`.includes("unit_kind") || `${error.message}`.includes("door_kind")) {
      console.error("This database has no unit_kind/door_kind columns yet — deploy 20260980000000 first.");
      process.exit(1);
    }
    throw error;
  }
  rows.push(...(data ?? []));
  if ((data?.length ?? 0) < PAGE) break;
}

const { writes, tally, doors } = planSpecKinds(rows);

console.log(`\nLive: ${tally.rows} mark specs on ${new Set(rows.map((r) => r.project_id)).size} jobs`);
console.log(`  windows       : ${tally.window}`);
console.log(`  doors         : ${tally.door}${describeDoors(doors)}`);
console.log(`  doesn't say   : ${tally.unknown} (stays null — the counts view has a bucket for these)`);
console.log(`  already right : ${tally.unchanged}`);
console.log(`  to write      : ${writes.length}`);

// The first twenty, so a person can sanity-check the reading against the
// paperwork before letting it write thousands of rows.
for (const w of writes.slice(0, 20)) {
  const was = w.from.unit_kind ? `${w.from.unit_kind}/${w.from.door_kind ?? "-"}` : "blank";
  const now = w.to.unit_kind ? `${w.to.unit_kind}/${w.to.door_kind ?? "-"}` : "blank";
  console.log(`    ${String(w.mark).padEnd(8)} ${was.padEnd(14)} -> ${now}`);
}
if (writes.length > 20) console.log(`    … and ${writes.length - 20} more`);

if (mode === "dry-run") {
  console.log("\nDry run only — nothing written. Re-run with --apply to write.");
  process.exit(0);
}

const batches = batchSpecKindWrites(writes);
let done = 0;
for (const b of batches) {
  const { error } = await supabase
    .from("project_mark_specs")
    .update(b.patch)
    .in("id", b.ids);
  if (error) throw error;
  done += b.ids.length;
}
console.log(`\nApplied: ${done} rows in ${batches.length} statements. Run again — it should report nothing left to write.`);
