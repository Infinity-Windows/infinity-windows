// The ownership rule the drain sends by (2026-09-25). See entryOwner.ts.

import { describe, expect, it } from "vitest";
import { belongsTo, ownershipOf } from "./entryOwner";
import { makeEntry, type OutboxEntry, type OutboxOp } from "./outbox-core";

const A = { userId: "user-a", email: "a@example.test" };
const B = { userId: "user-b", email: "b@example.test" };
const NOBODY = { userId: null, email: null };

function entry(op: OutboxOp, payload: Record<string, unknown>, ownerId?: string): OutboxEntry {
  return makeEntry({ op, payload, ownerId }, "e1", 0);
}

describe("whose queued write is it", () => {
  it("one queued by this build or later belongs to exactly the person who queued it", () => {
    const e = entry("clock_in", { projectId: "p1" }, A.userId);
    expect(ownershipOf(e, A)).toBe("mine");
    expect(ownershipOf(e, B)).toBe("theirs");
    expect(ownershipOf(e, NOBODY)).toBe("theirs");
    expect(belongsTo(e, A)).toBe(true);
    expect(belongsTo(e, B)).toBe(false);
  });

  it("nobody signed in owns nothing, whatever the entry says", () => {
    expect(belongsTo(entry("photo_upload", { createdBy: "a@example.test" }), NOBODY)).toBe(false);
    expect(belongsTo(entry("clock_in", {}), NOBODY)).toBe(false);
  });

  it("an older Hex-Portal write belongs to the actor it names", () => {
    for (const op of ["hex_portal_case", "hex_portal_outcome", "hex_learning_draft"] as const) {
      const e = entry(op, { actorId: A.userId });
      expect(ownershipOf(e, A)).toBe("mine");
      expect(ownershipOf(e, B)).toBe("theirs");
    }
  });

  it("an older photo or receipt upload belongs to the photographer's email, in any case", () => {
    for (const op of ["photo_upload", "receipt_upload"] as const) {
      const e = entry(op, { createdBy: "A@Example.TEST" });
      expect(ownershipOf(e, A)).toBe("mine");
      expect(ownershipOf(e, B)).toBe("theirs");
    }
  });

  it("an older write with no evidence belongs to no one — not the person signed in, whoever that is", () => {
    // Codex review of #660, P1 #1: who happened to be signed in when this
    // copy of the app started is not evidence of who queued an old punch.
    const e = entry("clock_in", { projectId: "p1", clientId: "punch-1" });
    expect(ownershipOf(e, A)).toBe("unknown");
    expect(ownershipOf(e, B)).toBe("unknown");
    expect(ownershipOf(e, NOBODY)).toBe("unknown");
    expect(belongsTo(e, A)).toBe(false);
  });

  it("evidence counts only where it really names the author — per op, and nowhere else", () => {
    // A photo's createdBy is the photographer; a clock punch carries no
    // createdBy, and one that somehow did is not taken as its owner.
    expect(ownershipOf(entry("clock_in", { createdBy: A.email }), A)).toBe("unknown");
    expect(ownershipOf(entry("receipt_capture", { createdBy: A.email }), A)).toBe("unknown");
    expect(ownershipOf(entry("issue_photo_upload", { createdBy: A.email }), A)).toBe("unknown");
    // An actorId only means the author on the Hex-Portal writes.
    expect(ownershipOf(entry("daily_log", { actorId: A.userId }), A)).toBe("unknown");
    // A blank name is no name.
    expect(ownershipOf(entry("photo_upload", { createdBy: "  " }), A)).toBe("unknown");
    expect(ownershipOf(entry("photo_upload", { createdBy: null }), A)).toBe("unknown");
  });

  it("an owner the entry carries outranks any evidence in its payload", () => {
    const e = entry("photo_upload", { createdBy: B.email }, A.userId);
    expect(ownershipOf(e, A)).toBe("mine");
    expect(ownershipOf(e, B)).toBe("theirs");
  });
});
