import { beforeEach, describe, expect, it } from "vitest";
import {
  findReplacementOpening,
  forgetOpeningTrail,
  recallOpening,
  rememberOpening,
} from "./staleOpening";

const o = (id: string, opening_code: string, status = "planned") => ({
  id,
  opening_code,
  status,
});

describe("findReplacementOpening", () => {
  const current = [
    o("new-9-1", "9-1"),
    o("new-9-2", "9-2"),
    o("new-9-10", "9-10"),
    o("new-14", "14"),
  ];

  it("follows the same code onto the new planset", () => {
    expect(findReplacementOpening(current, "9-2")).toEqual({
      opening: o("new-9-2", "9-2"),
      exact: true,
    });
  });

  it("ignores case, a leading # and stray spaces", () => {
    expect(findReplacementOpening(current, " #18b-1 ")).toBeNull();
    expect(findReplacementOpening([o("x", "18B-1")], "#18b-1 ")?.exact).toBe(true);
  });

  it("falls back to another opening of the same mark", () => {
    const found = findReplacementOpening(current, "9-7");
    expect(found?.exact).toBe(false);
    expect(found?.opening.opening_code).toBe("9-1");
  });

  it("prefers an opening that still needs doing over an installed one", () => {
    const found = findReplacementOpening(
      [o("a", "9-1", "installed"), o("b", "9-2")],
      "9-7",
    );
    expect(found?.opening.opening_code).toBe("9-2");
  });

  it("orders same-mark candidates naturally, not lexicographically", () => {
    const found = findReplacementOpening([o("a", "9-10"), o("b", "9-2")], "9-7");
    expect(found?.opening.opening_code).toBe("9-2");
  });

  it("gives up rather than guessing when the mark is gone", () => {
    expect(findReplacementOpening(current, "77-1")).toBeNull();
    expect(findReplacementOpening([], "9-1")).toBeNull();
    expect(findReplacementOpening(current, "  ")).toBeNull();
  });
});

describe("opening trail", () => {
  beforeEach(() => forgetOpeningTrail());

  it("remembers the code an id stood for", () => {
    rememberOpening("id-1", "proj-1", "9-1");
    expect(recallOpening("id-1")).toEqual({ projectId: "proj-1", code: "9-1" });
  });

  it("knows nothing about ids it has never seen", () => {
    expect(recallOpening("never")).toBeNull();
    expect(recallOpening("")).toBeNull();
  });

  it("survives a re-remember with a changed code", () => {
    rememberOpening("id-1", "proj-1", "9-1");
    rememberOpening("id-1", "proj-1", "9-2");
    expect(recallOpening("id-1")?.code).toBe("9-2");
  });

  it("keeps the trail bounded so a phone's storage never fills", () => {
    for (let i = 0; i < 400; i += 1) {
      rememberOpening(`id-${i}`, "proj-1", `${i}-1`);
    }
    expect(recallOpening("id-0")).toBeNull();
    expect(recallOpening("id-399")?.code).toBe("399-1");
  });
});
