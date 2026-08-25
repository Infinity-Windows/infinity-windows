// Testing projects (owner-confirmed 2026-08-25) are fake data for practice
// or QA — their material must never count as real inventory. `packages`
// isn't RLS-gated on `projects.is_test` (see the migration comment on
// 20260933000000_testing_projects.sql for why: the project a package
// belongs to is optional and mutable, and packages are reached through
// project joins all over the UI, not one list a policy can narrow), so the
// warehouse draws that line here instead — client-side, once, before any
// count, card or split-warning is computed.
//
// An installer or foreman never receives a test project in their `projects`
// list at all (RLS on SELECT), so for them `testProjectIds` is always empty
// and every partition below is a no-op — there is nothing to exclude
// because there was never anything to see.

/** The project ids flagged `is_test`, from whatever project list a page
 * already fetched. Works against `Project` or any looser shape a screen
 * happens to hold. */
export function testProjectIds(
  projects: { id: string; is_test?: boolean }[],
): Set<string> {
  return new Set(projects.filter((p) => p.is_test === true).map((p) => p.id));
}

export interface TestPartition<T> {
  /** Everything that counts as actual inventory. */
  real: T[];
  /** Belongs to a testing project — practice material, never counted. */
  testing: T[];
}

/**
 * Split packages (or anything else project-scoped) into real vs. testing.
 * Boneyard stock (`project_id === null`) is always real — it belongs to no
 * job, testing or otherwise.
 */
export function partitionTestPackages<T extends { project_id: string | null }>(
  packages: T[],
  testIds: Set<string>,
): TestPartition<T> {
  if (testIds.size === 0) return { real: packages, testing: [] };
  const real: T[] = [];
  const testing: T[] = [];
  for (const p of packages) {
    if (p.project_id && testIds.has(p.project_id)) testing.push(p);
    else real.push(p);
  }
  return { real, testing };
}
