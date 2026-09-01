#!/usr/bin/env node
// Repair MADMOOSE's project_openings after the 2026-09-01 addendum-upload
// data loss (fixed forward in the cross-document reconciliation PR): the
// specs-addendum processing hard-deleted all ten original openings — pins
// included — and minted three impostor rows whose "Add-#N" codes were
// normalized down to bare "1"/"2"/"3", colliding with the real marks.
//
// This restores the exact pre-deletion state:
//   1. DELETE the three impostor rows — identified precisely: this project,
//      the addendum planset (262c6006-...), codes 1/2/3, all created
//      2026-09-01T18:24 in one statement. Nothing else matches that shape.
//   2. INSERT openings for marks 1-10, insert-if-absent by code, with the
//      pin coordinates the owner confirmed from the vision run — captured
//      by direct production query BEFORE the deletion (this session's
//      probes), confidence 0.9-0.95, verified against the sheet's printed
//      callouts. page_number is the page the pin lives on (the floor plan,
//      page 1 — mark 9 on page 2), which is where the tracer reads it.
//
// Modes: plan (default, local-only) / --dry-run / --apply, like the other
// madmoose seeds. --dry-run/--apply need SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY (the Run seed script workflow provides both).

const ADDENDUM_PLANSET = "262c6006-7453-42dd-8906-36506e6e5e21";
const PROJECT = "08c60cce-29f6-4b52-bd0c-2bc2c02a79a9";

// opening_code -> { page, x, y } — the confirmed pins as they stood live
// before the addendum upload (captured 2026-08-31/09-01, this session).
export const RESTORE_PINS = {
  "1": { page: 1, x: 0.575, y: 0.174 },
  "2": { page: 1, x: 0.121, y: 0.169 },
  "3": { page: 1, x: 0.062, y: 0.879 },
  "4": { page: 1, x: 0.253, y: 0.879 },
  "5": { page: 1, x: 0.331, y: 0.892 },
  "6": { page: 1, x: 0.878, y: 0.694 },
  "7": { page: 1, x: 0.867, y: 0.418 },
  "8": { page: 1, x: 0.851, y: 0.291 },
  "9": { page: 2, x: 0.657, y: 0.845 },
  "10": { page: 1, x: 0.037, y: 0.334 },
};

const mode = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--dry-run")
    ? "dry-run"
    : "plan";

console.log("Repair plan for MADMOOSE openings");
console.log(`  delete   : impostor codes 1/2/3 on addendum planset ${ADDENDUM_PLANSET.slice(0, 8)}…`);
console.log(`  restore  : ${Object.keys(RESTORE_PINS).length} openings with their confirmed pins (insert-if-absent)`);
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

const { data: existing, error: eErr } = await supabase
  .from("project_openings")
  .select("id, opening_code, planset_id, pin_x, created_at")
  .eq("project_id", PROJECT);
if (eErr) throw eErr;

const impostors = (existing ?? []).filter(
  (o) => o.planset_id === ADDENDUM_PLANSET && ["1", "2", "3"].includes(o.opening_code),
);
const have = new Set(
  (existing ?? [])
    .filter((o) => !impostors.some((i) => i.id === o.id))
    .map((o) => o.opening_code),
);
const toRestore = Object.entries(RESTORE_PINS).filter(([code]) => !have.has(code));

console.log(`\nLive: ${existing?.length ?? 0} openings`);
console.log(`  impostors to delete : ${impostors.length} (${impostors.map((o) => o.opening_code).join(", ") || "none"})`);
console.log(`  openings to restore : ${toRestore.length} (${toRestore.map(([c]) => c).join(", ") || "none — all present"})`);

if (mode === "dry-run") {
  console.log("\nDry run only — nothing written.");
  process.exit(0);
}

if (impostors.length) {
  const { error } = await supabase
    .from("project_openings")
    .delete()
    .in("id", impostors.map((o) => o.id));
  if (error) throw error;
}
for (const [code, pin] of toRestore) {
  const { error } = await supabase.from("project_openings").insert({
    project_id: PROJECT,
    opening_code: code,
    page_number: pin.page,
    pin_x: pin.x,
    pin_y: pin.y,
    confirmed: true,
  });
  if (error) throw error;
}
console.log(`\nRepaired: ${impostors.length} impostors removed, ${toRestore.length} openings restored with pins.`);
