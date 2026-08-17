// The movements event list may only ever GROW.
//
// This test exists because of a real broken deploy (2026-08-17). The one-log
// migration rebuilt `movements_event_ck` from the ORIGINAL 20260715 list,
// unaware that four later migrations had widened it — `assigned`,
// `uninstalled`, `preissued`, `unloaded`. Production rows carried those
// values, the ALTER refused, and every migration behind it stayed unapplied
// for an hour while the app looked fine (its fallbacks hid it).
//
// A source test is the honest check here: no test runner in this repo can
// reach production, but the migration files ARE the schema's history, and a
// value that a migration once allowed must never silently disappear.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../supabase/migrations",
);

const values = (block: string): string[] =>
  [...block.matchAll(/'([a-z_]+)'/g)].map((v) => v[1]);

/**
 * Every event check on the MOVEMENTS table, in migration order.
 *
 * Scoped to that table on purpose: `package_events` carries its own, much
 * shorter `check (event in (...))`, and counting it here would read as the
 * vocabulary shrinking when it is simply a different table.
 */
function eventChecks(): { file: string; values: string[] }[] {
  const out: { file: string; values: string[] }[] = [];
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve(migrationsDir, file), "utf8");

    // The original inline check inside `create table movements ( … )`.
    const created = sql.match(/create\s+table\s+(?:if\s+not\s+exists\s+)?movements\s*\(([\s\S]*?)\n\);/i);
    if (created) {
      const inline = created[1].match(/event\s+text[\s\S]*?check\s*\(\s*event\s+in\s*\(([\s\S]*?)\)\s*\)/i);
      if (inline) out.push({ file, values: values(inline[1]) });
    }

    // Every later redefinition.
    for (const m of sql.matchAll(
      /alter\s+table\s+movements\s+add\s+constraint\s+\w+\s+check\s*\(\s*event\s+in\s*\(([\s\S]*?)\)\s*\)/gi,
    )) {
      out.push({ file, values: values(m[1]) });
    }
  }
  return out.filter((c) => c.values.length > 0);
}

describe("the movements event vocabulary", () => {
  const checks = eventChecks();

  it("is defined by at least one migration", () => {
    expect(checks.length).toBeGreaterThan(0);
  });

  it("only ever grows — no redefinition drops a value an earlier one allowed", () => {
    const allowed = new Set<string>();
    for (const { file, values } of checks) {
      const dropped = [...allowed].filter((v) => !values.includes(v));
      expect(
        dropped,
        `${file} drops event value(s) an earlier migration allowed: ${dropped.join(", ")}. ` +
          `Widen the list instead of retyping it — production rows already carry these.`,
      ).toEqual([]);
      for (const v of values) allowed.add(v);
    }
  });

  it("still carries the four values that broke the deploy", () => {
    const latest = checks[checks.length - 1].values;
    for (const v of ["assigned", "uninstalled", "preissued", "unloaded"]) {
      expect(latest, `the newest event check lost '${v}'`).toContain(v);
    }
  });

  it("carries the package and supply events the one-log migration added", () => {
    const latest = checks[checks.length - 1].values;
    for (const v of ["bound", "stored", "checked_out", "took"]) {
      expect(latest, `the newest event check is missing '${v}'`).toContain(v);
    }
  });
});
