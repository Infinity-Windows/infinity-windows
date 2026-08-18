import { describe, expect, it } from "vitest";
import { buildLines, existingParts, lineLabel } from "./tagBatch";
import type { StoragePackage } from "../storage";

let seq = 0;
const blank = (code: string): StoragePackage =>
  ({ id: `b${++seq}`, serial: `PKG-00000${seq}`, short_code: code, status: "blank" }) as StoragePackage;

const tagged = (over: Partial<StoragePackage> & { marks?: string[] }): StoragePackage => {
  const { marks, ...rest } = over;
  return {
    id: `t${++seq}`,
    serial: `PKG-1000${seq}`,
    short_code: null,
    status: "received",
    project_id: "job-1",
    package_marks: (marks ?? ["16"]).map((mark_code) => ({ mark_code })),
    ...rest,
  } as StoragePackage;
};

describe("the worksheet lines", () => {
  it("three pieces make three lines, stickers already attached", () => {
    const lines = buildLines(3, [blank("AAAAAA"), blank("BBBBBB"), blank("CCCCCC")]);
    expect(lines.map((l) => l.sticker?.short_code)).toEqual(["AAAAAA", "BBBBBB", "CCCCCC"]);
    expect(lines.map((l) => l.partIndex)).toEqual([1, 2, 3]);
  });

  it("a dry roll leaves a line sticker-less rather than silently shrinking", () => {
    const lines = buildLines(3, [blank("AAAAAA")]);
    expect(lines[0].sticker).not.toBeNull();
    expect(lines[1].sticker).toBeNull();
    expect(lines[2].sticker).toBeNull();
  });

  it("typing the window renames every line at once", () => {
    expect(lineLabel("16", 2, 3)).toBe("#16 2/3");
    expect(lineLabel("", 2, 3)).toBe("2/3");
  });
});

describe("the late package (add-on, missed box)", () => {
  it("a fresh window stands alone — no growth talk", () => {
    expect(existingParts([], "job-1", "16", 1)).toBeNull();
  });

  it("adding one to a 3-of-3 window continues at 4 and grows everyone to of-4", () => {
    const rows = [1, 2, 3].map((i) => tagged({ part_index: i, part_total: 3 }));
    const g = existingParts(rows, "job-1", "16", 1)!;
    expect(g).toEqual({ have: 3, maxIndex: 3, oldTotal: 3, newTotal: 4 });
  });

  it("numbering continues past a gap rather than reusing a printed number", () => {
    // Parts 1 and 3 exist (2 was burned or never tagged): the next line is 4,
    // not 2 — the paper reading "3/x" is already on a box.
    const rows = [1, 3].map((i) => tagged({ part_index: i, part_total: 3 }));
    const g = existingParts(rows, "job-1", "16", 1)!;
    expect(g.maxIndex).toBe(3);
    expect(g.newTotal).toBe(4);
  });
});
