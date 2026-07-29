import { describe, expect, it } from "vitest";
import {
  checkProject,
  EXPECTED_PROJECT_REF,
  parseProjectRef,
  projectWarning,
} from "./supabaseProject";

const PROD = `https://${EXPECTED_PROJECT_REF}.supabase.co`;
const OTHER = "https://jvsyhtarnvmdilsgksdi.supabase.co";

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
