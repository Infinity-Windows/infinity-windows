// The rule that decides what a daily log written in a dead zone does to the
// one already on the server when it finally lands.
//
// The scenario, in full: a foreman types a log in a truck with no signal at
// 4pm. A second foreman files for the same job-day from the office at 5pm.
// file_daily_log upserts on (project_id, log_date), so at 6pm when the first
// phone reconnects, a blind resend would replace the 5pm log with the 4pm one
// — silently, on a row both people share, with no copy of the lost text.

import { describe, expect, it } from "vitest";
import { mergeQueuedDailyLog, type QueuedDailyLog } from "./dailyLogMerge";
import type { DailyLog } from "./dailyLogs";

function queued(over: Partial<QueuedDailyLog> = {}): QueuedDailyLog {
  return {
    projectId: "black22",
    logDate: "2026-09-05",
    headline: null,
    notes: "Set four units on the south wall.",
    dayFlow: null,
    reflection: null,
    weather: null,
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

  it("sends what was typed when it was typed on the end of the server's own text", () => {
    // What an ordinary edit looks like: the dialog seeded the box from the
    // server's row, somebody added a sentence, and the whole box came back.
    const edited = "Glass showed up late, crew of three. Set four units on the south wall.";
    expect(mergeQueuedDailyLog(queued({ notes: edited }), server()).notes).toBe(edited);
  });

  it("lets an edit that DELETES a line stand", () => {
    const trimmed = "Glass showed up late.";
    const out = mergeQueuedDailyLog(
      queued({ notes: `${trimmed} Crew of three.` }),
      server({ notes: trimmed }),
    );
    expect(out.notes).toBe(`${trimmed} Crew of three.`);
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

  it("says the late half came in late, and names nobody", () => {
    // Daily-log notes reach a builder or GC login through stg_day, which hands
    // over headline/notes/day_flow and deliberately withholds filed_by. A crew
    // name spliced into the notes would walk straight through that wall; the
    // first version of this line put an email address there.
    const out = mergeQueuedDailyLog(queued(), server());
    expect(out.notes).toContain("— added later from a phone that was offline");
    expect(out.notes).not.toMatch(/@/);
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

// The two cases the old timestamp rule got wrong. It merged only when the
// server's `updated_at` looked newer than the moment the phone queued the
// entry, which compared Postgres's clock against a phone's.
describe("no clocks are consulted, because both of these look like 'nobody raced'", () => {
  it("appends when the log was written offline over an EXISTING one it could not read", () => {
    // Offline the dialog's lookup pauses rather than resolving, so the notes
    // box opens empty and what comes back never saw the morning's log. The
    // server's row is older than the queue moment, so a timestamp rule called
    // this "nobody raced" and replaced a full day of notes with the addendum.
    const morning = server({
      notes: "Morning: glass delivered.",
      created_at: "2026-09-05T13:00:00Z",
      updated_at: "2026-09-05T13:00:00Z",
    });
    const out = mergeQueuedDailyLog(queued({ notes: "Also set four on the south wall." }), morning);
    expect(out.notes).toContain("Morning: glass delivered.");
    expect(out.notes).toContain("Also set four on the south wall.");
  });

  it("appends when the phone's clock runs minutes fast", () => {
    // lib/clockSkew.ts exists because phones here do this, and ClockSheet has
    // a "my time is wrong" checkbox for the same reason. A phone five minutes
    // ahead reported a queue time later than the race that actually happened.
    const raced = server({ notes: "Filed from the office.", updated_at: "2026-09-05T16:02:00Z" });
    const out = mergeQueuedDailyLog(queued(), raced);
    expect(out.notes).toContain("Filed from the office.");
    expect(out.notes).toContain("Set four units on the south wall.");
  });
});
