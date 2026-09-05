// The rule that decides what a daily log written in a dead zone does to the
// one already on the server when it finally lands.
//
// The scenario, in full: a foreman types a log in a truck with no signal at
// 4pm. A second foreman files for the same job-day from the office at 5pm.
// file_daily_log upserts on (project_id, log_date), so at 6pm when the first
// phone reconnects, a blind resend would replace the 5pm log with the 4pm one
// — silently, on a row both people share, with no copy of the lost text.

import { describe, expect, it } from "vitest";
import { mergeQueuedDailyLog, serverMovedOn, type QueuedDailyLog } from "./dailyLogMerge";
import type { DailyLog } from "./dailyLogs";

const QUEUED_AT = Date.parse("2026-09-05T16:00:00Z");

function queued(over: Partial<QueuedDailyLog> = {}): QueuedDailyLog {
  return {
    projectId: "black22",
    logDate: "2026-09-05",
    headline: null,
    notes: "Set four units on the south wall.",
    dayFlow: null,
    reflection: null,
    weather: null,
    queuedAt: QUEUED_AT,
    authorName: "Sam",
    ...over,
  };
}

function server(over: Partial<DailyLog> = {}): DailyLog {
  return {
    id: "log-1",
    project_id: "black22",
    log_date: "2026-09-05",
    headline: null,
    notes: "Glass showed up late, crew of three.",
    day_flow: null,
    reflection: null,
    weather: null,
    customer_visible: false,
    customer_visible_at: null,
    filed_by: "someone-else",
    updated_by: null,
    created_at: "2026-09-05T17:00:00Z",
    updated_at: "2026-09-05T17:00:00Z",
    ...over,
  };
}

describe("nobody raced — the ordinary case, and it stays boring", () => {
  it("sends exactly what was typed when no log exists yet", () => {
    const out = mergeQueuedDailyLog(queued({ headline: "South wall", weather: "Hot" }), null);
    expect(out).toEqual({
      headline: "South wall",
      notes: "Set four units on the south wall.",
      dayFlow: null,
      reflection: null,
      weather: "Hot",
    });
  });

  it("sends what was typed when the server's row predates the queue", () => {
    const old = server({ updated_at: "2026-09-05T15:00:00Z" });
    expect(mergeQueuedDailyLog(queued(), old).notes).toBe("Set four units on the south wall.");
  });
});

describe("somebody else filed while this sat in a truck", () => {
  it("APPENDS rather than replacing — neither account is lost", () => {
    const out = mergeQueuedDailyLog(queued(), server());
    expect(out.notes).toContain("Glass showed up late, crew of three.");
    expect(out.notes).toContain("Set four units on the south wall.");
    // The server's text comes first: it is what a person reading the log
    // right now already saw.
    expect(out.notes.indexOf("Glass showed up")).toBeLessThan(
      out.notes.indexOf("Set four units"),
    );
  });

  it("names whose phone the late half came from", () => {
    expect(mergeQueuedDailyLog(queued(), server()).notes).toContain(
      "— added later from Sam's phone",
    );
  });

  it("still says where it came from when the name is unknown", () => {
    const out = mergeQueuedDailyLog(queued({ authorName: null }), server());
    expect(out.notes).toContain("— added later from a phone that was offline");
  });

  it("does not append the same words twice on a resend", () => {
    // The queue retries; the second attempt must not stack another copy.
    const once = mergeQueuedDailyLog(queued(), server());
    const twice = mergeQueuedDailyLog(queued(), server({ notes: once.notes }));
    expect(twice.notes).toBe(once.notes);
  });

  it("keeps the server's headline, day flow and weather", () => {
    const out = mergeQueuedDailyLog(
      queued({ headline: "Mine", dayFlow: "stuck", weather: "Rain" }),
      server({ headline: "Theirs", day_flow: "smooth", weather: "Clear" }),
    );
    expect(out.headline).toBe("Theirs");
    expect(out.dayFlow).toBe("smooth");
    expect(out.weather).toBe("Clear");
  });

  it("fills only the fields the server left blank", () => {
    const out = mergeQueuedDailyLog(
      queued({ headline: "Mine", dayFlow: "stuck", weather: "Rain" }),
      server({ headline: null, day_flow: null, weather: "   " }),
    );
    expect(out.headline).toBe("Mine");
    expect(out.dayFlow).toBe("stuck");
    expect(out.weather).toBe("Rain");
  });

  it("merges the reflection key by key — four one-liners, nothing to fight over", () => {
    const out = mergeQueuedDailyLog(
      queued({ reflection: { went_well: "Mine", went_poorly: "Mine too" } }),
      server({ reflection: { went_poorly: "Theirs", what_worked: "Theirs too" } }),
    );
    expect(out.reflection).toEqual({
      went_well: "Mine",
      went_poorly: "Theirs", // both filled it: the later writer wins
      what_worked: "Theirs too",
    });
  });

  it("keeps the server's notes when the queued half is empty", () => {
    const out = mergeQueuedDailyLog(queued({ notes: "   " }), server());
    expect(out.notes).toBe("Glass showed up late, crew of three.");
  });
});

describe("serverMovedOn", () => {
  it("is true only when the row changed after this was queued", () => {
    expect(serverMovedOn(server({ updated_at: "2026-09-05T17:00:00Z" }), QUEUED_AT)).toBe(true);
    expect(serverMovedOn(server({ updated_at: "2026-09-05T15:00:00Z" }), QUEUED_AT)).toBe(false);
  });

  // Cautious on purpose: an unreadable timestamp costs an appended paragraph,
  // while assuming "nobody raced" costs somebody's whole day of notes.
  it("treats an unreadable timestamp as a race", () => {
    expect(serverMovedOn(server({ updated_at: "not a date" }), QUEUED_AT)).toBe(true);
  });

  it("falls back to created_at when there is no updated_at", () => {
    const row = server({ created_at: "2026-09-05T18:00:00Z" });
    (row as { updated_at: string | null }).updated_at = null;
    expect(serverMovedOn(row, QUEUED_AT)).toBe(true);
  });
});
