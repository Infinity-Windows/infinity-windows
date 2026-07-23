import { describe, expect, it } from "vitest";
import { countUnreadByProject, totalUnread, type UnreadMessage } from "./unread";

const msg = (
  project_id: string,
  author_id: string,
  created_at: string,
): UnreadMessage => ({ project_id, author_id, created_at });

describe("countUnreadByProject", () => {
  it("counts messages after last_read_at, per project", () => {
    const messages = [
      msg("p1", "other", "2026-07-23T10:00:00Z"),
      msg("p1", "other", "2026-07-23T11:00:00Z"),
      msg("p2", "other", "2026-07-23T09:00:00Z"),
    ];
    const counts = countUnreadByProject(
      messages,
      { p1: "2026-07-23T10:30:00Z" },
      "me",
    );
    expect(counts).toEqual({ p1: 1, p2: 1 });
  });

  it("treats a never-read project as fully unread", () => {
    const messages = [
      msg("p1", "other", "2026-07-23T10:00:00Z"),
      msg("p1", "other", "2026-07-23T11:00:00Z"),
    ];
    expect(countUnreadByProject(messages, {}, "me")).toEqual({ p1: 2 });
  });

  it("excludes the viewer's own messages", () => {
    const messages = [
      msg("p1", "me", "2026-07-23T10:00:00Z"),
      msg("p1", "other", "2026-07-23T11:00:00Z"),
    ];
    expect(countUnreadByProject(messages, {}, "me")).toEqual({ p1: 1 });
  });

  it("omits projects with no unread messages", () => {
    const messages = [msg("p1", "other", "2026-07-23T10:00:00Z")];
    const counts = countUnreadByProject(
      messages,
      { p1: "2026-07-23T12:00:00Z" },
      "me",
    );
    expect(counts).toEqual({});
  });

  it("counts a message exactly at last_read_at as already read", () => {
    const messages = [msg("p1", "other", "2026-07-23T10:00:00Z")];
    const counts = countUnreadByProject(
      messages,
      { p1: "2026-07-23T10:00:00Z" },
      "me",
    );
    expect(counts).toEqual({});
  });

  it("compares timestamps by instant, not string form", () => {
    // Mixed offset/format: message in +00:00, cursor as Z millis — same instant.
    const messages = [msg("p1", "other", "2026-07-23T10:00:00.500+00:00")];
    const counts = countUnreadByProject(
      messages,
      { p1: "2026-07-23T10:00:00.000Z" },
      "me",
    );
    expect(counts).toEqual({ p1: 1 });
  });

  it("handles a null selfId (no self-exclusion)", () => {
    const messages = [msg("p1", "anyone", "2026-07-23T10:00:00Z")];
    expect(countUnreadByProject(messages, {}, null)).toEqual({ p1: 1 });
  });
});

describe("totalUnread", () => {
  it("sums every project's count", () => {
    expect(totalUnread({ p1: 2, p2: 3 })).toBe(5);
  });

  it("is zero for an empty map", () => {
    expect(totalUnread({})).toBe(0);
  });
});
