import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The offline pre-load has to actually pre-load (warehouse ticket D9).
 *
 * prefetchWarehousePack() promises the warehouse answers are on the phone
 * before somebody walks into a conex. Its only caller used to be the warehouse
 * page itself, firing at the same mount as that page's own queries — it could
 * not get ahead of anything it was supposed to be ahead of. Moving it to
 * sign-in is the whole fix, and nothing about it is observable from a unit
 * test: it is a side effect in an effect hook, in the one component nothing
 * here can practically mount.
 *
 * So this reads App.tsx as text. It is a wiring check, not a behavior test:
 * it can only prove the call sits in the session effect, which is exactly the
 * thing that regressed. The real proof is the Network tab right after sign-in.
 *
 * To be exact about the limit, because the first version of this note was not:
 * a DOM IS available per file (`// @vitest-environment happy-dom`, the way
 * Warehouse.test.tsx mounts the real page). What is not practical is mounting
 * App itself — it pulls the entire route tree and every module side effect
 * behind it to observe one fire-and-forget call. What the pack actually WARMS
 * is covered behaviourally instead, in lib/queryClient.warmsLocations.test.ts;
 * this file only answers "does anything call it before the warehouse page".
 */

const APP_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "./App.tsx");

/** The body of the useEffect that establishes the auth session. */
function sessionEffect(src: string): string {
  const anchor = src.indexOf("supabase.auth.getSession");
  expect(anchor, "App.tsx no longer establishes a session here").toBeGreaterThan(-1);
  // Walk back to the top of the effect: the work done on sign-in may sit in a
  // helper declared above the getSession call, so starting at the call itself
  // would read only half the effect.
  const start = src.lastIndexOf("useEffect(", anchor);
  expect(start, "getSession is not inside a useEffect").toBeGreaterThan(-1);
  const end = src.indexOf("}, []);", anchor);
  expect(end, "could not find the end of the session effect").toBeGreaterThan(anchor);
  return src.slice(start, end);
}

describe("the warehouse pre-load runs at sign-in", () => {
  const src = readFileSync(APP_PATH, "utf8");

  it("imports the pre-load", () => {
    expect(src).toContain("prefetchWarehousePack");
  });

  it("fires it from the session effect, not from a page that needs it now", () => {
    expect(sessionEffect(src)).toContain("prefetchWarehousePack");
  });

  it("covers a restored session and a fresh sign-in alike", () => {
    // Two ways in: the getSession() call on a cold open, and onAuthStateChange
    // when somebody signs in. A pre-load wired to only one of them misses half
    // the crew — whichever half, it is the half that gets no head start.
    const effect = sessionEffect(src);
    expect(effect).toContain("onAuthStateChange");
    const helper = /const (\w+) = \(s: Session \| null\) => \{/.exec(effect)?.[1];
    expect(helper, "both branches should run the same sign-in work").toBeTruthy();
    // Called once per branch, plus its own declaration.
    expect(effect.split(helper!).length - 1).toBeGreaterThanOrEqual(3);
  });
});
