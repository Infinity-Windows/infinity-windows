import { describe, expect, it } from "vitest";
import {
  diffVault,
  notesToIngest,
  pickSyncMode,
  summarizeDiff,
  type LiveDocLite,
  type ScannedNote,
} from "./vaultDiff";

const note = (path: string, hash: string): ScannedNote => ({
  path,
  title: path,
  content: `content-${hash}`,
  hash,
});

describe("diffVault", () => {
  const live: LiveDocLite[] = [
    { path: "b.md", hash: "h-b" },
    { path: "c.md", hash: "h-c" },
    { path: "d.md", hash: "h-d" },
  ];

  it("classifies added / changed / removed and ignores unchanged", () => {
    const scanned = [
      note("c.md", "h-c"), // unchanged
      note("d.md", "h-d2"), // changed
      note("a.md", "h-a"), // added (b/c/d live; a is new)
    ];
    const diff = diffVault(live, scanned);
    expect(diff.added.map((n) => n.path)).toEqual(["a.md"]);
    expect(diff.changed.map((n) => n.path)).toEqual(["d.md"]);
    expect(diff.removed.map((d) => d.path)).toEqual(["b.md"]);
  });

  it("orders each bucket by path (stable UI)", () => {
    const diff = diffVault(
      [],
      [note("z.md", "1"), note("a.md", "2"), note("m.md", "3")],
    );
    expect(diff.added.map((n) => n.path)).toEqual(["a.md", "m.md", "z.md"]);
  });

  it("treats an empty scan as everything removed (server still guards a wipe)", () => {
    const diff = diffVault(live, []);
    expect(diff.added).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.removed.map((d) => d.path)).toEqual(["b.md", "c.md", "d.md"]);
  });
});

describe("summarizeDiff / notesToIngest", () => {
  const diff = diffVault(
    [{ path: "keep.md", hash: "k" }, { path: "gone.md", hash: "g" }],
    [note("keep.md", "k2"), note("new.md", "n")],
  );

  it("counts buckets and flags hasChanges", () => {
    const s = summarizeDiff(diff);
    expect(s).toMatchObject({ added: 1, changed: 1, removed: 1, total: 3, hasChanges: true });
  });

  it("hasChanges is false when nothing differs", () => {
    const clean = diffVault([{ path: "a.md", hash: "1" }], [note("a.md", "1")]);
    expect(summarizeDiff(clean).hasChanges).toBe(false);
  });

  it("notesToIngest returns added + changed only, path-sorted", () => {
    expect(notesToIngest(diff).map((n) => n.path)).toEqual(["keep.md", "new.md"]);
  });
});

describe("pickSyncMode", () => {
  it("auto when the File System Access API is available, manual otherwise", () => {
    expect(pickSyncMode({ hasDirectoryPicker: true })).toBe("auto");
    expect(pickSyncMode({ hasDirectoryPicker: false })).toBe("manual");
  });
});
