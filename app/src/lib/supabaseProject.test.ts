import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkProject,
  DEFAULT_EXPECTED_PROJECT_REF,
  EXPECTED_PROJECT_REF,
  parseProjectRef,
  projectWarning,
  resolveExpectedRef,
} from "./supabaseProject";

const PROD = `https://${EXPECTED_PROJECT_REF}.supabase.co`;
const OTHER = "https://jvsyhtarnvmdilsgksdi.supabase.co";

/**
 * Load a fresh copy of the module with `VITE_EXPECTED_SUPABASE_PROJECT_REF` set
 * to `value` (or absent when undefined). The env var is read once at import, so
 * the module cache has to be dropped between cases.
 */
async function importWithEnv(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) {
    vi.stubEnv("VITE_EXPECTED_SUPABASE_PROJECT_REF", undefined);
  } else {
    vi.stubEnv("VITE_EXPECTED_SUPABASE_PROJECT_REF", value);
  }
  return await import("./supabaseProject");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("parseProjectRef", () => {
  it("reads the ref from a hosted Supabase URL", () => {
    expect(parseProjectRef(PROD)).toBe(EXPECTED_PROJECT_REF);
    expect(parseProjectRef(OTHER)).toBe("jvsyhtarnvmdilsgksdi");
  });

  it("ignores path, port and trailing slash", () => {
    expect(parseProjectRef(`${PROD}/`)).toBe(EXPECTED_PROJECT_REF);
    expect(parseProjectRef(`${PROD}/rest/v1`)).toBe(EXPECTED_PROJECT_REF);
  });

  it("returns null for a missing URL", () => {
    expect(parseProjectRef(undefined)).toBeNull();
    expect(parseProjectRef("")).toBeNull();
  });

  it("returns null for localhost / self-hosted URLs", () => {
    expect(parseProjectRef("http://localhost:54321")).toBeNull();
    expect(parseProjectRef("https://supabase.internal.example.com")).toBeNull();
  });

  it("returns null for a malformed URL instead of throwing", () => {
    expect(parseProjectRef("not a url")).toBeNull();
    expect(parseProjectRef("czprjcskmzzagdztqonm.supabase.co")).toBeNull();
  });
});

describe("checkProject", () => {
  it("is ok when the ref matches the shared project", () => {
    expect(checkProject(PROD)).toEqual({
      status: "ok",
      ref: EXPECTED_PROJECT_REF,
    });
  });

  it("flags a mismatch when pointed at another project", () => {
    expect(checkProject(OTHER)).toEqual({
      status: "mismatch",
      ref: "jvsyhtarnvmdilsgksdi",
    });
  });

  it("reports unset when the env var is missing or blank", () => {
    expect(checkProject(undefined)).toEqual({ status: "unset" });
    expect(checkProject("   ")).toEqual({ status: "unset" });
  });

  it("reports unknown for localhost / self-hosted", () => {
    expect(checkProject("http://localhost:54321")).toEqual({
      status: "unknown",
      url: "http://localhost:54321",
    });
  });

  it("reports unknown for a malformed URL", () => {
    expect(checkProject("https://")).toEqual({
      status: "unknown",
      url: "https://",
    });
  });
});

describe("projectWarning", () => {
  it("warns only on a mismatch, naming both projects", () => {
    expect(projectWarning(OTHER)).toEqual({
      connected: "jvsyhtarnvmdilsgksdi",
      expected: EXPECTED_PROJECT_REF,
    });
  });

  it("stays quiet for the shared project", () => {
    expect(projectWarning(PROD)).toBeNull();
  });

  it("stays quiet when the URL is missing, local, or malformed", () => {
    expect(projectWarning(undefined)).toBeNull();
    expect(projectWarning("http://localhost:54321")).toBeNull();
    expect(projectWarning("nope")).toBeNull();
  });

  it("honours an explicit expected ref", () => {
    expect(projectWarning(PROD, "someotherref")).toEqual({
      connected: EXPECTED_PROJECT_REF,
      expected: "someotherref",
    });
  });
});

describe("resolveExpectedRef", () => {
  it("uses a bare ref as given, lower-cased", () => {
    expect(resolveExpectedRef("jvsyhtarnvmdilsgksdi")).toBe(
      "jvsyhtarnvmdilsgksdi",
    );
    expect(resolveExpectedRef("  jvsyhtarnvmdilsgksdi  ")).toBe(
      "jvsyhtarnvmdilsgksdi",
    );
    expect(resolveExpectedRef("JVSYHTARNVMDILSGKSDI")).toBe(
      "jvsyhtarnvmdilsgksdi",
    );
  });

  it("accepts a whole Supabase URL, because someone will paste one", () => {
    expect(resolveExpectedRef(OTHER)).toBe("jvsyhtarnvmdilsgksdi");
    expect(resolveExpectedRef(`${OTHER}/rest/v1`)).toBe("jvsyhtarnvmdilsgksdi");
    expect(resolveExpectedRef("jvsyhtarnvmdilsgksdi.supabase.co")).toBe(
      "jvsyhtarnvmdilsgksdi",
    );
  });

  it("falls back when unset, empty or whitespace", () => {
    expect(resolveExpectedRef(undefined)).toBe(DEFAULT_EXPECTED_PROJECT_REF);
    expect(resolveExpectedRef(null)).toBe(DEFAULT_EXPECTED_PROJECT_REF);
    expect(resolveExpectedRef("")).toBe(DEFAULT_EXPECTED_PROJECT_REF);
    expect(resolveExpectedRef("   ")).toBe(DEFAULT_EXPECTED_PROJECT_REF);
    expect(resolveExpectedRef("\t\n ")).toBe(DEFAULT_EXPECTED_PROJECT_REF);
  });

  it("falls back for junk rather than disabling the guard", () => {
    expect(resolveExpectedRef("not a ref")).toBe(DEFAULT_EXPECTED_PROJECT_REF);
    expect(resolveExpectedRef("https://example.com")).toBe(
      DEFAULT_EXPECTED_PROJECT_REF,
    );
    expect(resolveExpectedRef("http://localhost:54321")).toBe(
      DEFAULT_EXPECTED_PROJECT_REF,
    );
  });
});

describe("EXPECTED_PROJECT_REF from VITE_EXPECTED_SUPABASE_PROJECT_REF", () => {
  it("defaults to the shared project when the env var is unset", async () => {
    const mod = await importWithEnv(undefined);
    expect(mod.EXPECTED_PROJECT_REF).toBe(DEFAULT_EXPECTED_PROJECT_REF);
    expect(mod.projectWarning(PROD)).toBeNull();
    expect(mod.projectWarning(OTHER)).toEqual({
      connected: "jvsyhtarnvmdilsgksdi",
      expected: DEFAULT_EXPECTED_PROJECT_REF,
    });
  });

  it("stays quiet when the env var matches the connected project", async () => {
    const mod = await importWithEnv("jvsyhtarnvmdilsgksdi");
    expect(mod.EXPECTED_PROJECT_REF).toBe("jvsyhtarnvmdilsgksdi");
    expect(mod.checkProject(OTHER)).toEqual({
      status: "ok",
      ref: "jvsyhtarnvmdilsgksdi",
    });
    expect(mod.projectWarning(OTHER)).toBeNull();
  });

  it("warns when the env var names a project other than the connected one", async () => {
    const mod = await importWithEnv("jvsyhtarnvmdilsgksdi");
    expect(mod.checkProject(PROD)).toEqual({
      status: "mismatch",
      ref: DEFAULT_EXPECTED_PROJECT_REF,
    });
    expect(mod.projectWarning(PROD)).toEqual({
      connected: DEFAULT_EXPECTED_PROJECT_REF,
      expected: "jvsyhtarnvmdilsgksdi",
    });
  });

  it("falls back to the default when the env var is blank, keeping the guard on", async () => {
    for (const blank of ["", "   "]) {
      const mod = await importWithEnv(blank);
      expect(mod.EXPECTED_PROJECT_REF).toBe(DEFAULT_EXPECTED_PROJECT_REF);
      expect(mod.projectWarning(OTHER)).toEqual({
        connected: "jvsyhtarnvmdilsgksdi",
        expected: DEFAULT_EXPECTED_PROJECT_REF,
      });
    }
  });

  it("accepts a full URL in the env var, not just a bare ref", async () => {
    const mod = await importWithEnv(OTHER);
    expect(mod.EXPECTED_PROJECT_REF).toBe("jvsyhtarnvmdilsgksdi");
    expect(mod.projectWarning(OTHER)).toBeNull();
  });
});
