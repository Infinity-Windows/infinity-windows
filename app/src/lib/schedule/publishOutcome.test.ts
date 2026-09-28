// What the Review & publish sheet may claim after a publish did not come back
// clean: "Nothing was published" only for a refusal the database itself
// returned; a lost reply is re-read, and the words follow what the re-read
// found (Codex's review of #646).
import { describe, expect, it } from "vitest";
import { isUnconfirmedPublishError, outcomeFromReadback, publishOutcomeMessage } from "./publishOutcome";

describe("telling a lost reply from a refusal", () => {
  it("a fetch failure, in every shape the phone sees it, is unconfirmed", () => {
    expect(isUnconfirmedPublishError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isUnconfirmedPublishError({ message: "TypeError: Failed to fetch", details: "", hint: "", code: "" })).toBe(true);
    expect(isUnconfirmedPublishError({ message: "TypeError: Load failed" })).toBe(true);
    expect(isUnconfirmedPublishError(new Error("The request timed out"))).toBe(true);
  });
  it("an answer from the database is a refusal, not an unknown", () => {
    expect(isUnconfirmedPublishError({ code: "42501", message: "new row violates row-level security policy" })).toBe(false);
    expect(isUnconfirmedPublishError({ code: "23514", message: "violates check constraint" })).toBe(false);
    expect(isUnconfirmedPublishError(new Error("The plan changed. Reload it before saving."))).toBe(false);
  });
});

describe("the outcome after a re-read", () => {
  it("every row published: success, exactly as if the reply had arrived", () => {
    expect(outcomeFromReadback({ published: ["a", "b"], drafts: [], missing: [] })).toEqual({ kind: "published", ids: ["a", "b"] });
  });
  it("some still draft: partial, and the sheet says how many", () => {
    const outcome = outcomeFromReadback({ published: ["a"], drafts: ["b", "c"], missing: [] });
    expect(outcome).toEqual({ kind: "partial", published: ["a"], drafts: ["b", "c"] });
    expect(publishOutcomeMessage(outcome as Exclude<typeof outcome, { kind: "published" }>)).toBe("Published 1 of 3; 2 still draft. Tap Publish again when you have signal.");
  });
  it("no re-read at all, or a row it could not read back: unconfirmed — no claim either way", () => {
    expect(outcomeFromReadback(null)).toEqual({ kind: "unconfirmed" });
    expect(outcomeFromReadback({ published: ["a"], drafts: [], missing: ["b"] })).toEqual({ kind: "unconfirmed" });
    expect(publishOutcomeMessage({ kind: "unconfirmed" })).toContain("couldn't confirm whether this was published");
    expect(publishOutcomeMessage({ kind: "unconfirmed" })).not.toContain("Nothing was published");
  });
  it("only a confirmed refusal says nothing was published", () => {
    expect(publishOutcomeMessage({ kind: "refused", message: "You don't have permission to do that." })).toBe("You don't have permission to do that. Nothing was published.");
  });
});
