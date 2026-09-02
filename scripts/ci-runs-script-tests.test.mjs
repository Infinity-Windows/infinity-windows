#!/usr/bin/env node
// Every test in scripts/ has to be named in the CI workflow, because a test
// nobody runs is not a check.
//
// Written after three seed tests sat in the repo without CI ever running one.
// Two of those seeds WRITE to production with the service key when someone runs
// the "Run seed script" workflow, and the rules deciding which rows they refuse
// to touch were guarded by a file that only ran if a person remembered to type
// its name. Every PR would have gone green through a change to any of them.
//
// The workflow lists each test by name on purpose — so a person reading it can
// see what runs, rather than trusting a glob — so the list is what gets checked.
// Run: node scripts/ci-runs-script-tests.test.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(join(here, "..", ".github/workflows/ci.yml"), "utf8");

// The three shapes a test in this directory takes: a bash one, a node one and
// a python one.
const isTest = (name) => /\.test\.(mjs|sh)$/.test(name) || /^test_.*\.py$/.test(name);
const tests = readdirSync(here).filter(isTest).sort();
assert.ok(tests.length > 10, "the scripts directory really was read");
assert.ok(tests.includes("ci-runs-script-tests.test.mjs"), "this check counts itself");

const missing = tests.filter((name) => !workflow.includes(`scripts/${name}`));
assert.deepEqual(
  missing,
  [],
  `no CI step runs ${missing.join(", ")} — add one to .github/workflows/ci.yml, ` +
    `or the next edit to it goes green either way`,
);

console.log(`ci-runs-script-tests: all ${tests.length} tests in scripts/ are named in ci.yml`);
