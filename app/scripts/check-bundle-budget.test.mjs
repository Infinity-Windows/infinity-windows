import { describe, expect, it } from "vitest";
import {
  BUDGET_GZIP_KB,
  checkBudget,
  findEntryChunk,
  firstScreenChunks,
  missingFromPrecache,
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
  it("reads the static imports out of a minified chunk, and never a dynamic one", () => {
    const code =
      'import{t as e}from"./rolldown-runtime-aKtaBQYM.js";import{n as r}from"./react-lCSYwAWP.js";' +
      'import"./side-effect-B1.js";export{c as d}from"./shared-C2.js";' +
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/Scanner-DYdUZuY5.js"])))=>i.map(i=>d[i]);' +
      'var Q=()=>import("./DispatchBoard-Q9.js");';
    expect(staticImportsOf(code).sort()).toEqual([
      "react-lCSYwAWP.js",
      "rolldown-runtime-aKtaBQYM.js",
      "shared-C2.js",
      "side-effect-B1.js",
    ]);
  });
});

describe("firstScreenChunks", () => {
  it("follows static imports all the way down and stops at dynamic ones", () => {
    const chunks = new Map([
      ["index-A.js", 'import{a}from"./react-B.js";import{b}from"./api-C.js";var l=()=>import("./Tab-D.js");'],
      ["react-B.js", ""],
      ["api-C.js", 'import{s}from"./supabase-E.js";'],
      ["supabase-E.js", 'import{a}from"./react-B.js";'],
      ["Tab-D.js", 'import{x}from"./heavy-F.js";'],
    ]);
    expect(firstScreenChunks("index-A.js", (f) => chunks.get(f)).sort()).toEqual([
      "api-C.js",
      "index-A.js",
      "react-B.js",
      "supabase-E.js",
    ]);
  });
});

describe("missingFromPrecache", () => {
  it("flags a first-screen chunk the service worker skips — the 2026-09-25 shape", () => {
    // React had landed in the crash monitor's chunk, which globIgnores keeps
    // out of the precache while monitoring is off.
    const sw =
      'precacheAndRoute([{url:"assets/index-A.js",revision:null},{url:"assets/react-B.js",revision:null}]);';
    expect(missingFromPrecache(["index-A.js", "react-B.js", "monitoring-M.js"], sw)).toEqual([
      "monitoring-M.js",
    ]);
  });

  it("is empty when every first-screen chunk is precached", () => {
    const sw = '[{url:"assets/index-A.js"},{url:"assets/react-B.js"}]';
    expect(missingFromPrecache(["index-A.js", "react-B.js"], sw)).toEqual([]);
  });
});
