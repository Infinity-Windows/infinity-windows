// Two promises this slice makes, pinned to the files that keep them:
//   1. The three start-work RPCs no longer re-check the toolbox talk (clock_in
//      already enforced it same-day), but they DO keep every other guard.
//   2. Every new clock-in-block / toolbox string ships in English AND Spanish.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, SAFETY_KEYS } from "./i18n/catalog";
import { translate } from "./i18n/translate";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATION = resolve(
  REPO,
  "supabase/migrations/20260969000000_drop_redundant_toolbox_recheck.sql",
);
const PROTOTYPE = resolve(REPO, "docs/prototype-migrations.sql");

describe("the redundant toolbox re-check is gone from start-work", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("rebuilds all three start-work functions in full", () => {
    expect(sql).toContain("create or replace function start_opening_work(p_opening_id uuid)");
    expect(sql).toContain("create or replace function start_opening_phase(p_opening_id uuid, p_kind text)");
    expect(sql).toContain("create or replace function start_unit_session(");
  });

  it("no longer checks toolbox_completions in any of them", () => {
    // The removed guard read `select 1 from toolbox_completions ...`. The
    // explanatory comment still names the table, so match the SQL, not the word.
    expect(sql).not.toContain("from toolbox_completions");
  });

  it("keeps the open-shift gate in every one", () => {
    // Three functions, three surviving "status = 'open'" checks.
    const matches = sql.match(/status = 'open' and clock_out_at is null/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it("keeps the other guards — flashing and the phase upsert", () => {
    // Flashing stays on the install paths (start_opening_work + start_unit_session).
    expect((sql.match(/_flashing_outstanding\(/g) ?? []).length).toBe(2);
    // The phase's on-conflict resume path is untouched.
    expect(sql).toContain("on conflict (opening_id, kind) do update");
    // Sessions still close/handoff and stamp the unit.
    expect(sql).toContain("_end_open_session(v_uid, 'handoff')");
    expect(sql).toContain("set work_started_at = coalesce(work_started_at, now())");
  });

  it("is mirrored into docs/prototype-migrations.sql", () => {
    const doc = readFileSync(PROTOTYPE, "utf8");
    expect(doc).toContain(
      "20260969000000_drop_redundant_toolbox_recheck.sql (mirrored)",
    );
    // And the mirrored 969 SECTION is the toolbox-free version, not a stale
    // copy. Bound the slice to just this section (up to the next mirrored
    // header) — a LATER migration's mirror may legitimately gate on the toolbox
    // (clock_in itself does), and that must not fail this assertion.
    const marker = "20260969000000_drop_redundant_toolbox_recheck.sql (mirrored)";
    const after = doc.slice(doc.indexOf(marker) + marker.length);
    const nextMirror = after.indexOf("(mirrored)");
    const section = nextMirror === -1 ? after : after.slice(0, nextMirror);
    expect(section).not.toContain("from toolbox_completions");
  });
});

describe("the new clock-in-block strings ship in both languages", () => {
  const NEW_KEYS = [
    "clockblock.title",
    "clockblock.subtitle",
    "clockblock.onClock",
    "clockblock.switch",
    "clockblock.needsFinish",
    "clockblock.needsFinishSub",
    "clockblock.moreOptions",
    "clockblock.notePlaceholder",
    "clockblock.notNearJob",
    "clockblock.signFirst",
    "clockblock.signAndClockIn",
    "clock.toolbox.signToClockIn",
    "clock.search.noJobs",
  ] as const;

  it("renders a real string in English and Spanish for each", () => {
    for (const key of NEW_KEYS) {
      const en = translate(CATALOG, "en", key);
      const es = translate(CATALOG, "es", key);
      expect(en, `en for ${key}`).toBeTruthy();
      expect(es, `es for ${key}`).toBeTruthy();
      // No bare key ever leaks (translate returns "" for an unknown key).
      expect(en).not.toBe(key);
      expect(es).not.toBe(key);
    }
  });

  it("flags the new sign-the-talk nudges as SAFETY keys", () => {
    for (const key of [
      "clock.toolbox.signToClockIn",
      "clockblock.signFirst",
      "clockblock.signAndClockIn",
    ]) {
      expect(SAFETY_KEYS as readonly string[]).toContain(key);
    }
  });

  it("interpolates the no-jobs search line in both languages", () => {
    expect(translate(CATALOG, "en", "clock.search.noJobs", { q: "peca" })).toContain("peca");
    expect(translate(CATALOG, "es", "clock.search.noJobs", { q: "peca" })).toContain("peca");
  });
});
