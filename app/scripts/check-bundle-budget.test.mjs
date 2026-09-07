import { describe, expect, it } from "vitest";
import { BUDGET_GZIP_KB, checkBudget, findEntryChunk } from "./check-bundle-budget.mjs";

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
