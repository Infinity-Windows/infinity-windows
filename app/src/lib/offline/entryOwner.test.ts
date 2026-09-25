// The ownership rule the drain sends by (2026-09-25). See entryOwner.ts.

import { describe, expect, it } from "vitest";
import { belongsTo, needsAdoption } from "./entryOwner";
import { makeEntry, type OutboxEntry } from "./outbox-core";

const A = { userId: "user-a", email: "a@example.test" };
const B = { userId: "user-b", email: "b@example.test" };
const NOBODY = { userId: null, email: null };

function entry(payload: Record<string, unknown>, ownerId?: string): OutboxEntry {
  return makeEntry({ op: "clock_in", payload, ownerId }, "e1", 0);
}

describe("whose queued write is it", () => {
  it("one queued by this build or later belongs to exactly the person who queued it", () => {
    const e = entry({ projectId: "p1" }, A.userId);
    expect(belongsTo(e, A, null)).toBe(true);
    expect(belongsTo(e, B, A.userId)).toBe(false);
    expect(belongsTo(e, NOBODY, A.userId)).toBe(false);
  });

  it("nobody signed in owns nothing, whatever the entry says", () => {
    expect(belongsTo(entry({ createdBy: "a@example.test" }), NOBODY, null)).toBe(false);
    expect(belongsTo(entry({}), NOBODY, null)).toBe(false);
  });

  it("an older Hex-Portal write belongs to the actor it names", () => {
    const e = entry({ actorId: A.userId });
    expect(belongsTo(e, A, B.userId)).toBe(true);
    expect(belongsTo(e, B, B.userId)).toBe(false);
    expect(needsAdoption(e)).toBe(false);
  });

  it("an older photo belongs to the photographer's email, in any case", () => {
    const e = entry({ createdBy: "A@Example.TEST" });
    expect(belongsTo(e, A, B.userId)).toBe(true);
    expect(belongsTo(e, B, B.userId)).toBe(false);
    expect(needsAdoption(e)).toBe(false);
  });

  it("an older write with no evidence belongs to whoever was signed in when the app started — and waits if nobody was", () => {
    const e = entry({ projectId: "p1" });
    expect(needsAdoption(e)).toBe(true);
    expect(belongsTo(e, A, A.userId)).toBe(true);
    expect(belongsTo(e, B, A.userId)).toBe(false);
    expect(belongsTo(e, A, null)).toBe(false);
  });

  it("an owner written onto an older entry settles it for good", () => {
    const adopted = { ...entry({ projectId: "p1" }), ownerId: A.userId };
    expect(needsAdoption(adopted)).toBe(false);
    // A later launch signed in as B cannot take it over.
    expect(belongsTo(adopted, B, B.userId)).toBe(false);
  });
});
