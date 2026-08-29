import { describe, expect, it } from "vitest";
import {
  buildDeleteConfirmMessage,
  daysLeftInTrash,
  daysSinceDeleted,
  trashStatusLine,
  TRASH_WINDOW_DAYS,
} from "./projectTrash";

const DAY = 24 * 60 * 60 * 1000;
const DELETED_AT = "2026-08-01T12:00:00.000Z";
const deletedAtMs = new Date(DELETED_AT).getTime();

describe("daysSinceDeleted", () => {
  it("is zero the instant a job is trashed", () => {
    expect(daysSinceDeleted(DELETED_AT, deletedAtMs)).toBe(0);
  });

  it("floors partial days", () => {
    expect(daysSinceDeleted(DELETED_AT, deletedAtMs + 3 * DAY + 60_000)).toBe(3);
  });

  it("never goes negative even if the server clock reads earlier than deleted_at", () => {
    expect(daysSinceDeleted(DELETED_AT, deletedAtMs - DAY)).toBe(0);
  });
});

describe("daysLeftInTrash", () => {
  it("starts at the full 30-day window", () => {
    expect(daysLeftInTrash(DELETED_AT, deletedAtMs)).toBe(TRASH_WINDOW_DAYS);
  });

  it("matches the '3 days ago — 27 days left' example from the spec", () => {
    expect(daysLeftInTrash(DELETED_AT, deletedAtMs + 3 * DAY)).toBe(27);
  });

  it("is exactly 1 the day before the deadline", () => {
    expect(daysLeftInTrash(DELETED_AT, deletedAtMs + 29 * DAY)).toBe(1);
  });

  it("hits exactly zero at the 30-day boundary — restore_project's own cutoff", () => {
    expect(daysLeftInTrash(DELETED_AT, deletedAtMs + 30 * DAY)).toBe(0);
  });

  it("never goes negative past the boundary (the sweep may not have run yet)", () => {
    expect(daysLeftInTrash(DELETED_AT, deletedAtMs + 45 * DAY)).toBe(0);
  });
});

describe("trashStatusLine", () => {
  it("reads 'deleted today' with the full window on day zero", () => {
    expect(trashStatusLine(DELETED_AT, deletedAtMs)).toBe("deleted today — 30 days left");
  });

  it("pluralizes both halves correctly at 3 days", () => {
    expect(trashStatusLine(DELETED_AT, deletedAtMs + 3 * DAY)).toBe("deleted 3 days ago — 27 days left");
  });

  it("singularizes both halves at exactly 1 day left", () => {
    expect(trashStatusLine(DELETED_AT, deletedAtMs + 29 * DAY)).toBe("deleted 29 days ago — 1 day left");
  });

  it("reads 'being erased' at the exact 30-day boundary, with Undo implied gone", () => {
    expect(trashStatusLine(DELETED_AT, deletedAtMs + 30 * DAY)).toBe("being erased");
  });

  it("stays 'being erased' well past the boundary too", () => {
    expect(trashStatusLine(DELETED_AT, deletedAtMs + 40 * DAY)).toBe("being erased");
  });
});

describe("buildDeleteConfirmMessage", () => {
  it("states the real cost in numbers, pluralized", () => {
    const msg = buildDeleteConfirmMessage("PECAN14", { openings: 42, packages: 118, photos: 1 });
    expect(msg).toContain("Delete PECAN14?");
    expect(msg).toContain("42 openings");
    expect(msg).toContain("118 packages");
    expect(msg).toContain("1 photo");
    expect(msg).not.toContain("1 photos");
    expect(msg).toContain("30 days to undo from Job history");
  });

  it("singularizes a lone opening/package too", () => {
    const msg = buildDeleteConfirmMessage("OAKRIDGE", { openings: 1, packages: 0, photos: 0 });
    expect(msg).toContain("1 opening,");
    expect(msg).toContain("0 packages");
  });
});
