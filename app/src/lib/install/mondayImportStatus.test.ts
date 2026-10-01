import { describe, expect, it } from "vitest";
import { isOfflineMondayError, mondayFileStatusText } from "./mondayImportStatus";

const catalog = {
  toPlans: "Added to Plans",
  toSpecs: "Added to Specs",
  toDocuments: "Added to Documents",
  already: "Already on the job",
  failed: "Not added",
  offline: "Check your connection and tap Retry.",
  needsRead: "Saved — tap Read this file below to pull its marks.",
};

describe("isOfflineMondayError", () => {
  it("catches supabase-js's own network-failure sentence", () => {
    expect(isOfflineMondayError("Failed to send a request to the Edge Function")).toBe(true);
  });

  it("catches the generic offline line formatApiError falls back to", () => {
    expect(isOfflineMondayError("You appear to be offline. Check your connection and try again.")).toBe(true);
  });

  it("leaves a real server refusal alone", () => {
    expect(isOfflineMondayError("Only a foreman or above can bring files in from Monday.")).toBe(false);
  });

  it("is false for nothing to check", () => {
    expect(isOfflineMondayError(null)).toBe(false);
    expect(isOfflineMondayError(undefined)).toBe(false);
    expect(isOfflineMondayError("")).toBe(false);
  });
});

describe("mondayFileStatusText", () => {
  it("labels a fresh plans landing and notes it still needs reading", () => {
    const status = mondayFileStatusText(
      { result: { asset_id: "1", name: "a", ok: true, where: "plans" } },
      catalog,
    );
    expect(status).toEqual({ ok: true, label: "Added to Plans", note: catalog.needsRead });
  });

  it("labels a fresh document landing with no read note", () => {
    const status = mondayFileStatusText(
      { result: { asset_id: "1", name: "a", ok: true, where: "documents" } },
      catalog,
    );
    expect(status).toEqual({ ok: true, label: "Added to Documents", note: undefined });
  });

  it("never notes an already-present file either way", () => {
    const status = mondayFileStatusText(
      { result: { asset_id: "1", name: "a", ok: true, already: true, where: "plans" } },
      catalog,
    );
    expect(status).toEqual({ ok: true, label: catalog.already, note: undefined });
  });

  it("carries the server's own sentence on a per-file failure", () => {
    const status = mondayFileStatusText(
      {
        result: {
          asset_id: "1",
          name: "a",
          ok: false,
          where: null,
          error: "This file is 96 MB. Anything over 80 MB has to be added by hand.",
        },
      },
      catalog,
    );
    expect(status).toEqual({
      ok: false,
      label: "Not added",
      detail: "This file is 96 MB. Anything over 80 MB has to be added by hand.",
    });
  });

  it("swaps a whole-request network failure for the bilingual offline line", () => {
    const status = mondayFileStatusText(
      { topError: "Failed to send a request to the Edge Function" },
      catalog,
    );
    expect(status).toEqual({ ok: false, label: "Not added", detail: catalog.offline });
  });

  it("keeps a real whole-request refusal verbatim", () => {
    const status = mondayFileStatusText(
      { topError: "Getting files from Monday needs the next database update." },
      catalog,
    );
    expect(status).toEqual({
      ok: false,
      label: "Not added",
      detail: "Getting files from Monday needs the next database update.",
    });
  });

  it("has no detail at all when nothing said why", () => {
    const status = mondayFileStatusText({}, catalog);
    expect(status).toEqual({ ok: false, label: "Not added", detail: undefined });
  });
});
