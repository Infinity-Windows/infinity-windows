// The trash cascade leaves no orphaned rows (standard-tracking-jobs slice 5).
//
// A PURE check over the project-scoped table list — the same set
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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  HERE,
  "../../../supabase/migrations/20260974000000_job_deletion_supervisor.sql",
);

/**
 * Every project-scoped table (link column in parentheses), mirroring
 * public.sandbox_scoped_tables() as of this slice. `projects` itself is the row
 * being erased, not a child to clean up. Keep this in step with the census: a
 * new project-scoped table lands in both, and scripts/test_sandbox_guard.py's
 * static gate is what forces you to notice the new table in the first place.
 */
const PROJECT_SCOPED: Record<string, string> = {
  attachments: "project_id",
  change_orders: "project_id",
  daily_logs: "project_id",
  flash_run_assignments: "project_id",
  incidents: "project_id",
  install_event_time_repairs: "project_opening_id",
  install_events: "project_opening_id",
  issues: "project_id",
  job_costs: "project_id",
  job_notes: "project_id",
  monday_jobs: "project_id",
  movements: "project_id",
  opening_notes: "opening_id",
  opening_phases: "opening_id",
  package_events: "project_id",
  packages: "project_id",
  partner_job_grants: "project_id",
  project_cost_codes: "project_id",
  project_mark_elevation_views: "project_id",
  project_mark_specs: "project_id",
  project_marks: "project_id",
  project_message_reads: "project_id",
  project_messages: "project_id",
  project_opening_pin_moves: "project_id",
  project_openings: "project_id",
  project_plan_outlines: "project_id",
  project_plansets: "project_id",
  project_spec_discrepancies: "project_id",
  project_windows: "project_id",
  qc_checks: "project_opening_id",
  receipts: "project_id",
  schedule_assignments: "project_id",
  service_cases: "project_id",
  studio_projects: "project_id",
  summons: "project_id",
  supply_orders: "project_id",
  takeoffs: "project_id",
  task_sessions: "project_id",
  time_shifts: "project_id",
  trips: "project_id",
  unit_redos: "opening_id",
  unit_sessions: "opening_id",
  vehicle_project_assignments: "project_id",
  windows: "project_id",
};

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

describe("purge_project handles every project-scoped table", () => {
  const body = purgeBody();

  for (const [table] of Object.entries(PROJECT_SCOPED)) {
    it(`accounts for ${table}`, () => {
      if (CASCADE_COVERED[table]) return; // covered by an FK, documented above
      const deleted = new RegExp(`\\bdelete from ${table}\\b`).test(body);
      const detached = new RegExp(`\\bupdate ${table} set\\b`).test(body);
      expect(
        deleted || detached,
        `${table} is project-scoped but purge_project neither deletes nor detaches it, and it is not in CASCADE_COVERED — a purge would orphan its rows or hit an FK`,
      ).toBe(true);
    });
  }

  it("only claims a cascade for a table that is actually project-scoped", () => {
    for (const table of Object.keys(CASCADE_COVERED)) {
      expect(PROJECT_SCOPED[table], `${table} in CASCADE_COVERED is not project-scoped`).toBeDefined();
    }
  });

  it("deletes the projects row itself", () => {
    expect(body).toContain("delete from projects where id = p_project_id;");
  });
});
