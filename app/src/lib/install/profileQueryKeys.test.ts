import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TWO LISTS OF PEOPLE MUST NEVER SHARE ONE CACHE KEY.
 *
 * `listProfiles()` leaves removed logins out; `listProfilesIncludingRemoved()`
 * keeps them. api.ts's own comment says why the split is where it is: excluding
 * them once, at the source, "makes the safe answer the default, so a picker
 * written next month gets it without anybody remembering".
 *
 * React Query caches by KEY, not by function. Every render of every observer on
 * a key calls setOptions and writes its own queryFn onto that one shared Query,
 * so two different functions under `["profiles"]` are not two lists — they are
 * whichever component rendered last. Twenty-odd screens hold `["profiles"]`
 * with `listProfiles`, including the app shell on every route, so a screen that
 * asked for the removed-inclusive list under that key would get either answer
 * at random: a picker could be handed a removed installer, and a Record card
 * could fail to put a name on finished work. Both directions are wrong, and
 * neither shows up as an error.
 *
 * This is a source scan rather than a runtime test because the mistake is a
 * two-word pairing at a call site: nothing type-checks a string key against a
 * function, and by the time the wrong list reaches a screen the two are far
 * apart. The fix is always the same — the removed-inclusive list belongs under
 * `["profilesIncludingRemoved"]`, which CrewAccess already invalidates
 * alongside `["profiles"]`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every `queryKey: [...]` in the tree with the text that follows it, which is
 * where its `queryFn` lives. A window rather than a parse: `useQuery` is always
 * written key-then-function in this codebase, and a scan that tried to parse
 * TypeScript would fail in a way nobody could read.
 */
function keyedQueries(): { file: string; key: string; after: string }[] {
  const out: { file: string; key: string; after: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/queryKey:\s*\[\s*"([A-Za-z]+)"\s*[,\]]/g)) {
      out.push({
        file: file.slice(SRC.length + 1),
        key: m[1],
        after: text.slice(m.index ?? 0, (m.index ?? 0) + 300),
      });
    }
  }
  return out;
}

describe("the two crew lists keep their own cache keys", () => {
  it("finds the call sites at all, so this test is not vacuous", () => {
    const keys = keyedQueries();
    expect(keys.filter((q) => q.key === "profiles").length).toBeGreaterThan(10);
    expect(
      keys.filter((q) => q.key === "profilesIncludingRemoved").length,
    ).toBeGreaterThan(2);
  });

  it("never reads the removed-inclusive list under the shared key", () => {
    const wrong = keyedQueries()
      .filter(
        (q) =>
          q.key === "profiles" && /listProfilesIncludingRemoved/.test(q.after),
      )
      .map((q) => q.file);
    // If this fails: change that call site's key to
    // ["profilesIncludingRemoved"]. Do not "fix" it by pointing the other
    // twenty screens at the removed-inclusive list — the whole point of the
    // split is that a picker gets the safe list without asking for it.
    expect(wrong).toEqual([]);
  });

  it("never reads the filtered list under the removed-inclusive key", () => {
    const wrong = keyedQueries()
      .filter(
        (q) =>
          q.key === "profilesIncludingRemoved" &&
          /queryFn:\s*listProfiles\b/.test(q.after),
      )
      .map((q) => q.file);
    expect(wrong).toEqual([]);
  });
});
