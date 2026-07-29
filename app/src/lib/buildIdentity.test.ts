import { describe, expect, it } from "vitest";
import {
  buildIdentity,
  compareToPublished,
  fingerprint,
  parseBuildId,
} from "./buildIdentity";
import { EXPECTED_PROJECT_REF } from "./supabaseProject";

const SHARED = `https://${EXPECTED_PROJECT_REF}.supabase.co`;
const OTHER_REF = "jvsyhtarnvmdilsgksdi";
const OTHER = `https://${OTHER_REF}.supabase.co`;
const SHA = "6837eded4cb722942a4d6a5e6468424abe5cd95e";

describe("parseBuildId", () => {
  it("reads a CI build as a released commit", () => {
    expect(parseBuildId(SHA)).toEqual({
      kind: "released",
      commit: "6837ede",
      dirty: false,
      raw: SHA,
    });
  });

  it("reads a local build stamped with a commit", () => {
    expect(parseBuildId("dev-g6837ede")).toMatchObject({
      kind: "local",
      commit: "6837ede",
      dirty: false,
    });
  });

  it("reads the dirty marker on a local build", () => {
    expect(parseBuildId("dev-g6837ede-dirty")).toMatchObject({
      kind: "local",
      commit: "6837ede",
      dirty: true,
    });
  });

  it("keeps an older timestamped local build usable, with no commit", () => {
    expect(parseBuildId("dev-1753822000000")).toMatchObject({
      kind: "local",
      commit: null,
      dirty: false,
    });
  });

  it("never mistakes a timestamp for a commit, though digits are valid hex", () => {
    // 13 decimal digits parse as hex, so without the `g` marker this would be
    // shown as the commit "1753822" — a code identity that does not exist.
    expect(parseBuildId("dev-1753822000000").commit).toBeNull();
    expect(fingerprint(parseBuildId("dev-1753822000000"), "db")).toContain(
      "dev-1753822000000",
    );
  });

  it("lower-cases and shortens a full sha so two people compare the same text", () => {
    expect(parseBuildId(SHA.toUpperCase()).commit).toBe("6837ede");
  });

  it("treats missing or unrecognisable ids as unknown rather than throwing", () => {
    for (const raw of ["", "   ", undefined, null, "not a build"]) {
      expect(parseBuildId(raw).kind).toBe("unknown");
    }
  });
});

describe("compareToPublished", () => {
  it("says current when the running build is the published one", () => {
    expect(compareToPublished(parseBuildId(SHA), SHA)).toEqual({
      status: "current",
    });
  });

  it("says stale, naming the published commit, when they differ", () => {
    const published = "aaaaaaabbbbbbbccccccdddddd00000011111122";
    expect(compareToPublished(parseBuildId(SHA), published)).toEqual({
      status: "stale",
      published: "aaaaaaa",
    });
  });

  it("never calls a local build stale — it is not the published artefact", () => {
    expect(compareToPublished(parseBuildId("dev-g6837ede"), SHA)).toEqual({
      status: "local",
    });
  });

  it("stays quiet when offline, because not knowing is not a problem", () => {
    expect(compareToPublished(parseBuildId(SHA), null)).toEqual({
      status: "unknown",
    });
  });
});

describe("fingerprint", () => {
  it("is identical for a local and a released build of the same commit", () => {
    const local = fingerprint(parseBuildId("dev-g6837ede"), EXPECTED_PROJECT_REF);
    const released = fingerprint(parseBuildId(SHA), EXPECTED_PROJECT_REF);
    expect(local).toBe(released);
  });

  it("differs when the database differs, even on identical code", () => {
    const build = parseBuildId(SHA);
    expect(fingerprint(build, EXPECTED_PROJECT_REF)).not.toBe(
      fingerprint(build, OTHER_REF),
    );
  });

  it("marks uncommitted edits, since they make the app genuinely different", () => {
    expect(fingerprint(parseBuildId("dev-g6837ede-dirty"), EXPECTED_PROJECT_REF)).toContain(
      "+edits",
    );
    expect(fingerprint(parseBuildId("dev-g6837ede"), EXPECTED_PROJECT_REF)).not.toContain(
      "+edits",
    );
  });

  it("falls back to the raw id rather than hiding an unrecognisable build", () => {
    expect(fingerprint(parseBuildId("weird"), EXPECTED_PROJECT_REF)).toContain("weird");
  });

  it("says so plainly when there is no database", () => {
    expect(fingerprint(parseBuildId(SHA), null)).toContain("no database");
  });
});

describe("buildIdentity", () => {
  const base = {
    runningBuildId: SHA,
    supabaseUrl: SHARED,
    publishedBuildId: SHA,
  };

  it("is happy when running the published build against the shared database", () => {
    const id = buildIdentity(base);
    expect(id.verdict.tone).toBe("ok");
    expect(id.verdict.label).toBe("Up to date");
    expect(id.database.shared).toBe(true);
    expect(id.fingerprint).toBe(`6837ede · ${EXPECTED_PROJECT_REF}`);
  });

  it("warns about the wrong database ahead of anything else", () => {
    const id = buildIdentity({
      ...base,
      supabaseUrl: OTHER,
      // Also stale: the database problem must still be the one reported.
      publishedBuildId: "aaaaaaabbbbbbbccccccdddddd00000011111122",
    });
    expect(id.verdict.label).toBe("Different database");
    expect(id.verdict.hint).toContain(EXPECTED_PROJECT_REF);
    expect(id.database.shared).toBe(false);
  });

  it("warns when the bundle is not the published one, naming what to expect", () => {
    const id = buildIdentity({
      ...base,
      publishedBuildId: "aaaaaaabbbbbbbccccccdddddd00000011111122",
    });
    expect(id.verdict.tone).toBe("warn");
    expect(id.verdict.label).toBe("Not the published build");
    expect(id.verdict.hint).toContain("aaaaaaa");
  });

  it("explains a local build instead of calling it a problem", () => {
    const id = buildIdentity({ ...base, runningBuildId: "dev-g6837ede" });
    expect(id.verdict.tone).toBe("info");
    expect(id.verdict.label).toBe("Local build of 6837ede");
  });

  it("calls out uncommitted edits, the reason two matching commits can differ", () => {
    const id = buildIdentity({ ...base, runningBuildId: "dev-g6837ede-dirty" });
    expect(id.verdict.label).toBe("Local build with uncommitted changes");
    expect(id.fingerprint).toContain("+edits");
  });

  it("does not nag when offline", () => {
    const id = buildIdentity({ ...base, publishedBuildId: null });
    expect(id.verdict.tone).toBe("info");
    expect(id.verdict.label).toBe("Can't check for updates");
  });

  it("tells someone with no database configured exactly what to do", () => {
    const id = buildIdentity({ ...base, supabaseUrl: "" });
    expect(id.verdict.label).toBe("No database configured");
    expect(id.verdict.hint).toContain(".env");
  });

  it("honours an overridden expected project", () => {
    const id = buildIdentity({
      ...base,
      supabaseUrl: OTHER,
      expectedRef: OTHER_REF,
    });
    expect(id.database.shared).toBe(true);
    expect(id.verdict.tone).toBe("ok");
  });

  it("two people on the same commit and database agree, whoever built it", () => {
    const taylor = buildIdentity(base);
    const ammon = buildIdentity({ ...base, runningBuildId: "dev-g6837ede" });
    expect(ammon.fingerprint).toBe(taylor.fingerprint);
  });

  it("two people on different databases disagree, even on identical code", () => {
    const taylor = buildIdentity(base);
    const ammon = buildIdentity({ ...base, supabaseUrl: OTHER });
    expect(ammon.fingerprint).not.toBe(taylor.fingerprint);
  });
});
