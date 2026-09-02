// The one-day sweep, read as SQL.
//
// No test runner in this repo can reach a database, but expire_summons runs
// unattended every ten minutes over every stale row on the books, so what
// makes it safe is worth pinning in the migration text itself — the same
// argument movementEvents.test.ts makes about a check constraint.
//
// What it must never do: stamp a helper who already tapped "Can't make it".
// Cancelling sets minutes = 0 and leaves completed_at NULL, so an unguarded
// sweep would credit that person up to eight hours for a call they backed
// out of five minutes in, and fire the session trigger's 'complete' branch
// on somebody who never completed.

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

/**
 * `canceled_at` arrives with cancel_summon_help (20260919000000). Before it,
 * a helper could not back out at all, so guarding on it would have been
 * meaningless — every statement from that migration onwards is fair game.
 */
const CANCEL_MIGRATION = "20260919000000_summon_cancel.sql";

/** Every `update summon_helpers … ;` statement in a file, whitespace flattened. */
function helperUpdates(sql: string): string[] {
  return [...sql.matchAll(/update\s+summon_helpers\b[\s\S]*?;/gi)].map((m) =>
    m[0].replace(/\s+/g, " "),
  );
}

describe("stamping a helper as complete", () => {
  const stamping = files()
    .filter((f) => f >= CANCEL_MIGRATION)
    .flatMap((file) =>
      helperUpdates(sqlOf(file))
        .filter((stmt) => /set\s+completed_at\s*=\s*now\(\)/i.test(stmt))
        .map((stmt) => ({ file, stmt })),
    );

  it("is something at least one migration since the cancel one does", () => {
    expect(stamping.length).toBeGreaterThan(0);
  });

  it("never touches a helper who backed out", () => {
    for (const { file, stmt } of stamping) {
      expect(/canceled_at\s+is\s+null/i.test(stmt), `${file}: ${stmt}`).toBe(true);
    }
  });
});
