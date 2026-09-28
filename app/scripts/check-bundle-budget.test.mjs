import { describe, expect, it } from "vitest";
import {
  BUDGET_GZIP_KB,
  FIRST_SCREEN_GZIP_KB,
  checkBudget,
  findEntryChunk,
  htmlScriptRoots,
  missingFromPrecache,
  staticImportClosure,
  staticImportsOf,
} from "./check-bundle-budget.mjs";

describe("findEntryChunk", () => {
  it("picks the hashed index-*.js entry out of a dist/assets listing", () => {
    const files = [
      "index-Bn03hcb6.js",
      "index-CedG7lSc.css",
      "MapsTrace-D9pFO4Hu.js",
      "index-Bn03hcb6.js.map",
    ];
    expect(findEntryChunk(files)).toBe("index-Bn03hcb6.js");
  });

  it("returns null when there is no entry chunk", () => {
    expect(findEntryChunk(["MapsTrace-D9pFO4Hu.js", "index-Bn03hcb6.css"])).toBeNull();
  });
});

describe("checkBudget", () => {
  it("passes when the entry chunk is under budget", () => {
    const result = checkBudget(200 * 1024, BUDGET_GZIP_KB);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("ok");
  });

  it("passes exactly at the budget", () => {
    const result = checkBudget(260 * 1024, 260);
    expect(result.ok).toBe(true);
  });

  it("fails once the entry chunk grows past budget, with an actionable message", () => {
    const result = checkBudget(261 * 1024, 260);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("over the 260 kB budget");
    expect(result.message).toContain("React.lazy");
  });

  it("uses the module's own BUDGET_GZIP_KB when no budget is passed", () => {
    // The real regression this guards against: three.js/pdf.js sneaking back
    // into the eager entry chunk. 233 kB was the measured size right after
    // route splitting landed; a jump like that should fail.
    const result = checkBudget(700 * 1024);
    expect(result.ok).toBe(false);
  });
});

describe("staticImportsOf", () => {
  it("reads chunk basenames out of minified `from\"./x.js\"` imports, no whitespace needed", () => {
    const source = 'import{a as e,b as t}from"./react-lCSYwAWP.js";import{n as r}from"./api-M7lzaKDu.js";';
    expect(staticImportsOf(source)).toEqual(["react-lCSYwAWP.js", "api-M7lzaKDu.js"]);
  });

  it("also catches a bare side-effect import", () => {
    expect(staticImportsOf('import"./polyfill-Abc123.js";')).toEqual(["polyfill-Abc123.js"]);
  });

  it("does not treat a dynamic import() as a static dependency", () => {
    // This is exactly the React.lazy()/lazyOptional() split that is SUPPOSED
    // to stay out of the first-screen closure.
    const source = 'const M=()=>import("./MapsInteractive-DeBSR7Dt.js");';
    expect(staticImportsOf(source)).toEqual([]);
  });

  it("de-duplicates a chunk imported more than once", () => {
    const source = 'from"./api-M7lzaKDu.js";from"./api-M7lzaKDu.js";';
    expect(staticImportsOf(source)).toEqual(["api-M7lzaKDu.js"]);
  });
});

describe("staticImportClosure", () => {
  it("walks static imports recursively, entry included, stopping at a dynamic import", () => {
    const files = {
      "index-A.js": 'from"./react-B.js";from"./api-C.js";const M=()=>import("./MapsInteractive-D.js");',
      "react-B.js": "// leaf",
      "api-C.js": 'from"./schemaErrors-E.js";',
      "schemaErrors-E.js": "// leaf",
      // MapsInteractive-D.js is deliberately absent: reaching it would be a
      // bug (a dynamic import must never be walked into).
    };
    const closure = staticImportClosure("index-A.js", (f) => files[f] ?? null);
    expect(new Set(closure)).toEqual(
      new Set(["index-A.js", "react-B.js", "api-C.js", "schemaErrors-E.js"]),
    );
  });

  it("does not loop forever on a cycle between chunks", () => {
    const files = {
      "a.js": 'from"./b.js";',
      "b.js": 'from"./a.js";',
    };
    const closure = staticImportClosure("a.js", (f) => files[f] ?? null);
    expect(new Set(closure)).toEqual(new Set(["a.js", "b.js"]));
  });

  it("fails on a missing built dependency even if the service worker lists it", () => {
    expect(() => staticImportClosure("index-A.js", () => null)).toThrow("Built first-screen chunk is missing");
  });
});

describe("built HTML eager roots", () => {
  it("includes module scripts and modulepreloads, and excludes styles and unrelated links", () => {
    const html = '<link rel="modulepreload" href="/assets/react-A.js"><link rel="stylesheet" href="/assets/index-A.css"><script type="module" src="/assets/index-B.js"></script>';
    expect(htmlScriptRoots(html)).toEqual(["react-A.js", "index-B.js"]);
    expect(FIRST_SCREEN_GZIP_KB).toBeGreaterThan(0);
  });
});

describe("missingFromPrecache", () => {
  it("passes when every closure file is in the precache manifest", () => {
    const precache = '[{"revision":null,"url":"assets/index-A.js"},{"revision":null,"url":"assets/react-B.js"}]';
    expect(missingFromPrecache(["index-A.js", "react-B.js"], precache)).toEqual([]);
  });

  it("names exactly the closure file the precache manifest never mentions", () => {
    // The #664/#667 shape: an entry-reachable file the service worker never
    // cached, so a phone with no signal can't render at all.
    const precache = '[{"revision":null,"url":"assets/index-A.js"}]';
    expect(missingFromPrecache(["index-A.js", "react-B.js"], precache)).toEqual(["react-B.js"]);
  });
});
