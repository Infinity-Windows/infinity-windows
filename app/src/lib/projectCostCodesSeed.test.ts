import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The slice-3 migration is the system of truth for the seed; this reads it as
// text and proves the two new company cost codes (and the general fallback the
// clock-in picker relies on) are seeded, and that the new project-scoped table
// arms the test-login fence. Reading the file rather than the live DB keeps it
// in the ~7s vitest suite with no network.
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(here, "../../../supabase/migrations/20260973000000_project_cost_codes.sql"),
  "utf8",
);

describe("20260973000000_project_cost_codes seed", () => {
  it("seeds the two new company cost codes", () => {
    expect(sql).toContain("'Service call'");
    expect(sql).toContain("'Warranty'");
  });

  it("seeds a general fallback code the picker can always include", () => {
    expect(sql).toMatch(/'General'.*true/);
    expect(sql).toContain("is_general");
  });

  it("creates the per-job subset table with a unique (project, code) pair", () => {
    expect(sql).toContain("create table if not exists project_cost_codes");
    expect(sql).toMatch(/unique \(project_id, cost_code_id\)/);
  });

  it("arms the sandbox guard on the new project-scoped table", () => {
    expect(sql).toContain("select public.attach_sandbox_guards();");
  });
});
