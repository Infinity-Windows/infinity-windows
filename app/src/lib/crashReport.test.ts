// @vitest-environment happy-dom
//
// The crash reporter exists because a crash already happened — so the one
// property everything here defends is that it can only ever ADD information,
// never fail loudly itself: same crash → same read-out-loud code, report
// bodies that fit the app_feedback CHECK, one row per crash site per load,
// and a resolved promise no matter what the network does.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCrashReportBody,
  crashDigest,
  reportCrash,
  resetCrashReportsForTest,
} from "./crashReport";

const getSession = vi.fn();
const insert = vi.fn();
const from = vi.fn((_table: string) => ({
  insert: (...args: unknown[]) => insert(...args),
}));
vi.mock("./supabase", () => ({
  supabaseConfigured: true,
  supabase: {
    auth: { getSession: (...args: unknown[]) => getSession(...args) },
    from: (table: string) => from(table),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetCrashReportsForTest();
  vi.spyOn(console, "error").mockImplementation(() => {});
  getSession.mockResolvedValue({ data: { session: { user: { id: "user-1" } } } });
  insert.mockResolvedValue({ error: null });
});

describe("crashDigest", () => {
  it("is five characters a crew can read out loud — no I, L, O, or U", () => {
    const code = crashDigest(new Error("Cannot access 'jobCodeMap' before initialization"));
    expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/);
  });

  it("gives the same crash the same code, and a different crash a different one", () => {
    const err = new Error("boom");
    expect(crashDigest(err)).toBe(crashDigest(err));
    expect(crashDigest(err)).not.toBe(crashDigest(new Error("a different boom")));
  });

  it("survives non-Error throwables", () => {
    expect(crashDigest("just a string")).toMatch(/^[0-9A-Z]{5}$/);
    expect(crashDigest(undefined)).toMatch(/^[0-9A-Z]{5}$/);
  });
});

describe("buildCrashReportBody", () => {
  it("leads with plain words, then carries the code, path, and error", () => {
    const err = new Error("Cannot access 'jobCodeMap' before initialization");
    const body = buildCrashReportBody(err, "\n    at JobMaterials", "/storage/jobs/BLACK22");
    expect(body).toContain("sent automatically");
    expect(body).toContain(crashDigest(err));
    expect(body).toContain("/storage/jobs/BLACK22");
    expect(body).toContain("Cannot access 'jobCodeMap'");
    expect(body).toContain("Component stack:");
  });

  it("stays inside app_feedback's 2000-char CHECK even for a huge stack", () => {
    const err = new Error("x".repeat(3000));
    const body = buildCrashReportBody(err, "\n    at Deep".repeat(500), "/");
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("reportCrash", () => {
  it("files a bug row on app_feedback as the signed-in user", async () => {
    const err = new Error("boom");
    await reportCrash(err, "\n    at Screen");
    expect(from).toHaveBeenCalledWith("app_feedback");
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0] as { author: string; kind: string; body: string };
    expect(row.author).toBe("user-1");
    expect(row.kind).toBe("bug");
    expect(row.body).toContain(crashDigest(err));
  });

  it("always writes the console line, even when it skips the upload", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const err = new Error("boom");
    await reportCrash(err, null);
    expect(console.error).toHaveBeenCalledWith(
      `App crashed [${crashDigest(err)}]`,
      err,
      "",
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("reports one crash site once per load — a Try-again loop must not spam owners", async () => {
    const err = new Error("boom");
    await reportCrash(err, null);
    await reportCrash(err, null);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("never rejects, whatever the network does — the crash screen depends on it", async () => {
    getSession.mockRejectedValue(new Error("offline"));
    await expect(reportCrash(new Error("boom"), null)).resolves.toBeUndefined();
  });
});
