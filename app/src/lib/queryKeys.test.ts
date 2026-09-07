import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OFFLINE_KEY_ROOTS, QUERY_KEY_ROOTS } from "./queryKeys";

/**
 * A new query-key root can no longer show up in the app without someone
 * answering "does the phone keep this offline?" — this test is the thing
 * that enforces that. It scans every source file for the roots actually
 * used and fails, by name, on anything not in `QUERY_KEY_ROOTS`; it also
 * fails if the registry carries a root nothing uses, and if the offline
 * set drifts from the exact list that was hand-kept in queryClient.ts
 * before this registry existed — so a silent drop of an offline key (the
 * kind of change a refactor makes by accident) fails loudly here instead
 * of showing up as a blank screen on someone's phone in a dead spot.
 *
 * TO REGISTER A NEW ROOT: add one row to QUERY_KEY_ROOTS in
 * app/src/lib/queryKeys.ts. Registering means deciding `offline` — does a
 * screen reading this query need to work with no signal? If yes, `offline:
 * true` and a `why` saying what breaks without it (an incident, or the
 * reasoning, in this repo's own voice). If the query is heavy, binary, or a
 * volatile search, `offline: false` needs no explanation.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// Matches the key styles actually used in this codebase: `queryKey: [...]`
// (which also covers cancelQueries/invalidateQueries/prefetchQuery/etc,
// since they all take the key under that label), the direct-array form
// `setQueryData([...])` / `getQueryData([...])` (with or without a generic
// type param), a query key stashed in a local `const fooKey = [...]`, and a
// key-builder function `const fooKey = (...) => [...]`. Roots are plain
// string literals (single, double, or a template literal with no
// interpolation) — every root in the app is written that way today.
const ROOT_PATTERNS = [
  /queryKey:\s*\[\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)/g,
  /(?:setQueryData|getQueryData)\s*(?:<[^>()]*>)?\s*\(\s*\[\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)/g,
  /const\s+\w*[Kk]ey\s*=\s*\[\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)/g,
  /const\s+\w*[Kk]ey\s*=\s*\([^)]*\)\s*(?::\s*[^=]+)?=>\s*\[\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)/g,
];

/** Every query-key root actually referenced in app/src, mapped to one file it was seen in. */
function usedRoots(): Map<string, string> {
  const seen = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const rel = file.slice(SRC.length + 1);
    for (const pattern of ROOT_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text))) {
        const root = m[1] ?? m[2] ?? m[3];
        if (root && !seen.has(root)) seen.set(root, rel);
      }
    }
  }
  return seen;
}

// The exact set that was hand-kept as OFFLINE_KEYS in queryClient.ts right
// before this registry replaced it (2026-09-06). If this test's other
// assertion on OFFLINE_KEY_ROOTS ever fails, it means the registry changed
// what the persister keeps — compare against this list to see whether that
// was intended.
const EXPECTED_OFFLINE_ROOTS = [
  "projects",
  "projectsAll",
  "openings",
  "scopeCounts",
  "projectWindows",
  "storagePackages",
  "storageContainers",
  "deliveries",
  "deliveryPackages",
  "scheduledMarks",
  "issues",
  "windowTypes",
  "typeBrain",
  "plansets",
  "opening",
  "myOpenings",
  "myProfile",
  "openShift",
  "myShifts",
  "costCodes",
  "learnProgress",
  "priorityTerms",
  "ledger",
  "pointsLeaderboard",
  "tools",
  "supplies",
  "todayTalk",
  "toolboxToday",
  "toolboxHistory",
  "openingPhases",
  "markSpecs",
  "planOutlines",
  "elevationViews",
  "locations",
  "trips",
  "trip",
].sort();

describe("every query-key root the app uses is registered", () => {
  it("finds roots at all, so this test is not vacuous", () => {
    expect(usedRoots().size).toBeGreaterThan(100);
  });

  it("has no root in the code that isn't in QUERY_KEY_ROOTS", () => {
    const registered = new Set(QUERY_KEY_ROOTS.map((e) => e.root));
    const missing = [...usedRoots().entries()]
      .filter(([root]) => !registered.has(root))
      .map(([root, file]) => `"${root}" (seen in ${file})`);
    // If this fails: a screen reads a query key nothing has registered.
    // Add one row for it to QUERY_KEY_ROOTS in app/src/lib/queryKeys.ts and
    // decide `offline` — does the phone need this with no signal? If yes,
    // offline: true and a why explaining what breaks without it.
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("has no root in QUERY_KEY_ROOTS that nothing uses", () => {
    const used = usedRoots();
    const stale = QUERY_KEY_ROOTS.map((e) => e.root).filter((root) => !used.has(root));
    // If this fails: remove the dead row from QUERY_KEY_ROOTS — the code
    // that used it is gone (or was renamed and the old root just needs
    // deleting).
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("has no duplicate root in QUERY_KEY_ROOTS", () => {
    const roots = QUERY_KEY_ROOTS.map((e) => e.root);
    const dupes = roots.filter((root, i) => roots.indexOf(root) !== i);
    expect(dupes).toEqual([]);
  });

  it("keeps the phone's offline set exactly what it was before the registry", () => {
    // A silent drop of an offline: true row is precisely the bug this
    // registry exists to prevent — this pins the set so it fails loudly.
    expect([...OFFLINE_KEY_ROOTS].sort()).toEqual(EXPECTED_OFFLINE_ROOTS);
  });
});
