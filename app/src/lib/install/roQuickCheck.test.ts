// "Numbers always win", read as SQL.
//
// No test runner in this repo can reach a database, so the half of that rule
// the database enforces is pinned in the migration text instead — the same
// argument summonExpiry.test.ts makes about the unattended sweep.
//
// The rule has two halves and both live in the server:
//
//   * saving a measurement clears the quick check, and
//   * a quick check refuses an opening that already has one.
//
// The second half is easy to forget, because the screen already hides the
// button once numbers are on file. A phone holding the pre-measurement row —
// bad signal, PWA cache — goes on drawing it, and an unguarded update would
// overwrite the measurer's name and the minute they took it, leaving a row
// with numbers AND a quick check on it. The fit verdict reads the tape either
// way, so nothing on any screen would look wrong; the provenance would just be
// gone. The same call is a plain POST for any authenticated crew member, which
// is why the UI cannot be the only thing holding the line.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../supabase/migrations",
);

const files = (): string[] =>
  readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

const sqlOf = (file: string): string => readFileSync(resolve(migrationsDir, file), "utf8");

/** The newest migration that defines this function — the one the database runs. */
function newestDefinitionOf(fn: string): string | undefined {
  return files()
    .filter((f) => new RegExp(`create\\s+or\\s+replace\\s+function\\s+${fn}\\b`, "i").test(sqlOf(f)))
    .pop();
}

/** The body of one function, cut at its closing `$$;` so a neighbour's
 *  statements in the same migration cannot be mistaken for its own. */
function bodyOf(sql: string, fn: string): string {
  const start = sql.search(
    new RegExp(`create\\s+or\\s+replace\\s+function\\s+${fn}\\b`, "i"),
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = sql.slice(start);
  const end = rest.indexOf("$$;");
  return end < 0 ? rest : rest.slice(0, end);
}

/** Every `update project_openings … ;` in a body, whitespace flattened. */
function openingUpdates(body: string): string[] {
  return [...body.matchAll(/update\s+project_openings\b[\s\S]*?;/gi)].map((m) =>
    m[0].replace(/\s+/g, " "),
  );
}

describe("quick_check_rough_opening", () => {
  const file = newestDefinitionOf("quick_check_rough_opening");

  it("is defined by a migration", () => {
    expect(file).toBeTruthy();
  });

  const writes = () =>
    openingUpdates(bodyOf(sqlOf(file!), "quick_check_rough_opening")).filter((stmt) =>
      /set\s+ro_quick_ok\s*=\s*true/i.test(stmt),
    );

  it("writes the flag", () => {
    expect(writes().length).toBeGreaterThan(0);
  });

  it("never touches an opening that already has tape numbers", () => {
    for (const stmt of writes()) {
      expect(/ro_width_in\s+is\s+null/i.test(stmt), stmt).toBe(true);
      expect(/ro_height_in\s+is\s+null/i.test(stmt), stmt).toBe(true);
    }
  });

  it("blames a measurement only when there is one to blame", () => {
    // The update also misses a soft-removed opening and a row this login may
    // not write. Telling that installer "somebody measured it" would send them
    // to reload a sheet that will say the same thing again.
    const body = bodyOf(sqlOf(file!), "quick_check_rough_opening");
    const blame = /if\s+exists\s*\(([\s\S]*?)\)\s*then\s*raise\s+exception\s*'Somebody measured/i.exec(
      body,
    );
    expect(blame, body).toBeTruthy();
    expect(/ro_width_in\s+is\s+not\s+null/i.test(blame![1])).toBe(true);
    expect(/ro_height_in\s+is\s+not\s+null/i.test(blame![1])).toBe(true);
  });

  it("only ever restamps who measured inside that same guard", () => {
    // ro_measured_by / ro_measured_at are the measurement's provenance. This
    // function is allowed to claim them only for an opening that has none.
    const stamping = openingUpdates(
      bodyOf(sqlOf(file!), "quick_check_rough_opening"),
    ).filter((stmt) => /set[\s\S]*ro_measured_(by|at)\s*=/i.test(stmt));
    expect(stamping.length).toBeGreaterThan(0);
    for (const stmt of stamping) {
      expect(/ro_width_in\s+is\s+null/i.test(stmt), stmt).toBe(true);
      expect(/ro_height_in\s+is\s+null/i.test(stmt), stmt).toBe(true);
    }
  });
});

describe("set_opening_rough_opening", () => {
  const file = newestDefinitionOf("set_opening_rough_opening");

  it("is defined by a migration", () => {
    expect(file).toBeTruthy();
  });

  it("clears the quick check whenever real numbers are saved", () => {
    const writes = openingUpdates(
      bodyOf(sqlOf(file!), "set_opening_rough_opening"),
    ).filter((stmt) => /set[\s\S]*ro_width_in\s*=/i.test(stmt));
    expect(writes.length).toBeGreaterThan(0);
    for (const stmt of writes) {
      expect(/ro_quick_ok\s*=\s*false/i.test(stmt), stmt).toBe(true);
    }
  });
});
