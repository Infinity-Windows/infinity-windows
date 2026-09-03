// The trash cascade leaves no orphaned rows (standard-tracking-jobs slice 5).
//
// A PURE check over the project-scoped table list — the SAME set
// public.sandbox_scoped_tables() returns (20260967000000), which the deploy's
// sandbox census reads. Every project-scoped table must be accounted for when a
// job is purged: detached (project_id -> null, the row survives), deleted
// outright, or removed by an FK cascade from a parent that IS deleted. A table
// that is none of those would orphan rows — or, worse, block the final
// `delete from projects` with an FK violation.
//
// This reads purge_project's body straight out of the migration and checks each
// scoped table against it. If a future migration adds a project-scoped table
// and forgets to handle it in purge_project, this test goes red before the
// orphan can ever happen — the same spirit as scripts/test_sandbox_guard.py's
// static gate, on the deletion side.
//
// HOW THE CENSUS GETS HERE (standard-tracking-jobs slice 5, review fix,
// 2026-09-03). This used to loop over a hand-typed 44-entry literal that merely
// CLAIMED to mirror sandbox_scoped_tables(). It did not read it, so a future
// migration adding a project-scoped table would leave the literal short, the
// new table absent from the loop, and the suite green while a purge orphaned
// its rows — the exact failure this file advertises it prevents. The list is
// now READ from the one static replay of that census, scripts/sandbox_guard.py's
// scoped_tables(), the same parser scripts/test_sandbox_guard.py gates on. There
// is deliberately no second copy of that parser here: a hand-mirror that drifts,
// or a re-implemented parser that disagrees with the real one, is how the
// missing-table check grew seventeen versions. A new scoped table now appears in
// this loop automatically and fails until purge_project handles it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../..");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");
const MIGRATION = join(
  REPO_ROOT,
  "supabase/migrations/20260974000000_job_deletion_supervisor.sql",
);

/**
 * The project-scoped census, read at runtime from the ONE static replay of
 * public.sandbox_scoped_tables() — scripts/sandbox_guard.py's scoped_tables(),
 * which walks every migration in version order. Returns {table -> link column}
 * for the children only; `projects` itself is the row being erased, not a child
 * to clean up, and `sandbox_projects` is never scoped (the replay excludes it).
 *
 * A subprocess, not a re-implementation: the migration parser lives in Python
 * and stays a single source of truth. If it cannot be reached this throws
 * loudly rather than returning an empty set — a census check that silently
 * measures nothing is the failure mode 20260967000000 exists to stop.
 */
function censusScopedTables(): Record<string, string> {
  const program = [
    "import sys, json",
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
    "from sandbox_guard import scoped_tables",
    "print(json.dumps({n: v[0] for n, v in scoped_tables().items() if n != 'projects'}))",
  ].join("; ");
  let raw: string;
  try {
    raw = execFileSync("python3", ["-c", program], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
  } catch (err) {
    throw new Error(
      "could not read the project-scoped census from scripts/sandbox_guard.py " +
        "(needs python3). This test proves purge_project covers every scoped " +
        "table and must not pass without the census: " +
        String(err),
    );
  }
  return JSON.parse(raw) as Record<string, string>;
}

/**
 * Tables purge_project does NOT name because an FK removes them for it — with
 * the reason, so a reviewer can check the claim against each table's migration.
 * install_events + its opening children all cascade when project_openings is
 * deleted; package_events rides its surviving package but its project_id is
 * SET NULL by the final `delete from projects`.
 */
const CASCADE_COVERED: Record<string, string> = {
  install_events: "ON DELETE CASCADE from project_openings",
  qc_checks: "ON DELETE CASCADE from project_openings",
  opening_phases: "ON DELETE CASCADE from project_openings",
  opening_notes: "ON DELETE CASCADE from project_openings",
  unit_redos: "ON DELETE CASCADE from project_openings",
  unit_sessions: "ON DELETE CASCADE from project_openings",
  install_event_time_repairs: "ON DELETE CASCADE from project_openings",
  project_opening_pin_moves: "ON DELETE CASCADE from project_openings",
  package_events:
    "package survives (detached); its project_id is ON DELETE SET NULL on the final delete from projects",
};

function purgeBody(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf("create or replace function public.purge_project");
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/**
 * Does purge_project account for `table`? Deleted outright, detached to null,
 * or removed by a documented FK cascade. Pure so the guarantee can be exercised
 * on a fabricated table below, not only on today's schema.
 */
function purgeCovers(table: string, body: string): boolean {
  if (CASCADE_COVERED[table]) return true; // covered by an FK, documented above
  const deleted = new RegExp(`\\bdelete from ${table}\\b`).test(body);
  const detached = new RegExp(`\\bupdate ${table} set\\b`).test(body);
  return deleted || detached;
}

describe("purge_project handles every project-scoped table", () => {
  const body = purgeBody();
  const census = censusScopedTables();

  it("the census replay actually found the schema", () => {
    // Guards against the loop below being vacuously green because the replay
    // returned nothing (broken parser, wrong path). Same spirit as
    // test_sandbox_guard.py's "the replay still finds the schema".
    expect(Object.keys(census).length).toBeGreaterThan(30);
    expect(census.project_openings).toBe("project_id");
    expect(census.unit_sessions).toBe("opening_id");
    // A table added in a later slice than this file was born — proof the census
    // is read live, not frozen at authoring time.
    expect(census.project_cost_codes).toBe("project_id");
    expect(census).not.toHaveProperty("projects");
    expect(census).not.toHaveProperty("sandbox_projects");
  });

  for (const table of Object.keys(census)) {
    it(`accounts for ${table}`, () => {
      expect(
        purgeCovers(table, body),
        `${table} is project-scoped (per sandbox_scoped_tables) but purge_project neither deletes nor detaches it, and it is not in CASCADE_COVERED — a purge would orphan its rows or hit an FK`,
      ).toBe(true);
    });
  }

  it("goes red for a scoped table purge_project does not handle", () => {
    // The guarantee, proven on the mechanism rather than on today's schema: a
    // FUTURE migration that makes a new table project-scoped puts it in the
    // census (via scoped_tables) and so in the loop above; unless purge_project
    // gains a delete/detach/cascade for it, purgeCovers returns false and the
    // suite goes red. A name the body genuinely handles reads as covered.
    expect(purgeCovers("zztest_new_unhandled_scoped_table", body)).toBe(false);
    expect(purgeCovers("project_openings", body)).toBe(true);
    expect(purgeCovers("movements", body)).toBe(true); // detached, not deleted
  });

  it("only claims a cascade for a table that is actually project-scoped", () => {
    for (const table of Object.keys(CASCADE_COVERED)) {
      expect(census[table], `${table} in CASCADE_COVERED is not project-scoped`).toBeDefined();
    }
  });

  it("deletes the projects row itself", () => {
    expect(body).toContain("delete from projects where id = p_project_id;");
  });
});
