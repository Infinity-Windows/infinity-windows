import { describe, expect, it } from "vitest";
import { resolvePushRecipients } from "./recipients";

describe("resolvePushRecipients", () => {
  it("pushes every assigned crew member on a normal message", () => {
    const ids = resolvePushRecipients({
      assignedCrewIds: ["a", "b"],
      supervisorOwnerIds: ["sup"],
      mentionedIds: [],
    });
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("does NOT push a supervisor/owner who is not assigned and not mentioned", () => {
    const ids = resolvePushRecipients({
      assignedCrewIds: ["a"],
      supervisorOwnerIds: ["sup", "owner"],
      mentionedIds: [],
    });
    expect(ids).not.toContain("sup");
    expect(ids).not.toContain("owner");
  });

  it("pushes a supervisor/owner ONLY when mentioned", () => {
    const ids = resolvePushRecipients({
      assignedCrewIds: ["a"],
      supervisorOwnerIds: ["sup"],
      mentionedIds: ["sup"],
    });
    expect(ids).toContain("sup");
    expect(ids).toContain("a");
  });

  it("includes a mentioned crew member (already covered) without duplicating", () => {
    const ids = resolvePushRecipients({
      assignedCrewIds: ["a", "b"],
      supervisorOwnerIds: [],
      mentionedIds: ["a"],
    });
    expect(ids).toEqual(["a", "b"]);
  });

  it("never pushes the author back to themselves", () => {
    const ids = resolvePushRecipients({
      assignedCrewIds: ["a", "b"],
      supervisorOwnerIds: ["sup"],
      mentionedIds: ["sup", "a"],
      authorId: "a",
    });
    expect(ids).not.toContain("a");
    expect(ids.sort()).toEqual(["b", "sup"]);
  });

  it("orders assigned crew first, then extra mentioned people", () => {
    const ids = resolvePushRecipients({
      assignedCrewIds: ["a", "b"],
      supervisorOwnerIds: ["sup"],
      mentionedIds: ["sup"],
    });
    expect(ids).toEqual(["a", "b", "sup"]);
  });
});
