import { describe, expect, it } from "vitest";
import {
  compareProjectsForList,
  daysBetween,
  dueNudges,
  materialsLate,
  materialsMissing,
  needsCall,
  shortDay,
  sortProjectsForList,
} from "./pipeline";

const TODAY = "2026-09-08";

/** A job with nothing wrong with it: ready, starting in a month, windows in. */
function fine(over: Record<string, unknown> = {}) {
  return {
    ready_state: "ready",
    start_date: "2026-10-08",
    materials_eta: "2026-09-01",
    materials_arrived_at: "2026-09-01T15:00:00Z",
    ...over,
  };
}

describe("daysBetween", () => {
  it("counts whole days forward and back", () => {
    expect(daysBetween(TODAY, "2026-09-15")).toBe(7);
    expect(daysBetween(TODAY, "2026-09-08")).toBe(0);
    expect(daysBetween(TODAY, "2026-09-01")).toBe(-7);
  });

  it("is null for a missing or unreadable date rather than NaN", () => {
    expect(daysBetween(TODAY, null)).toBeNull();
    expect(daysBetween(TODAY, undefined)).toBeNull();
    expect(daysBetween(TODAY, "")).toBeNull();
    expect(daysBetween(TODAY, "next Tuesday")).toBeNull();
  });

  it("reads a full timestamp by its day half", () => {
    expect(daysBetween(TODAY, "2026-09-15T23:30:00Z")).toBe(7);
  });

  it("does not lose a day across a daylight-saving change", () => {
    // 2026-11-01 is the US fall-back Sunday: local midnight to local midnight
    // across it is 25 hours, which truncating division would call 0 days.
    expect(daysBetween("2026-10-31", "2026-11-01")).toBe(1);
    expect(daysBetween("2026-10-25", "2026-11-08")).toBe(14);
    // And the spring-forward Sunday, 23 hours the other way.
    expect(daysBetween("2026-03-07", "2026-03-08")).toBe(1);
  });
});

describe("shortDay", () => {
  it("prints a card-sized date with no year", () => {
    expect(shortDay("2026-09-22", "en-US")).toBe("Sep 22");
  });

  it("does not slip a day backwards across a timezone", () => {
    // The whole reason these are parsed as LOCAL midnight: `new Date("2026-09-
    // 22")` is UTC midnight, which prints as Sep 21 anywhere west of Greenwich.
    expect(shortDay("2026-09-22T00:00:00", "en-US")).toBe("Sep 22");
  });

  it("renders a missing or unreadable date as nothing, never Invalid Date", () => {
    expect(shortDay(null)).toBe("");
    expect(shortDay(undefined)).toBe("");
    expect(shortDay("")).toBe("");
    expect(shortDay("soon")).toBe("");
  });
});

describe("needsCall", () => {
  it("says nothing about a job that is ready with its windows in", () => {
    const r = needsCall(fine(), TODAY);
    expect(r.call).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("does not nag about a job three months out that is not ready yet", () => {
    // Not ready is normal a long way from the start date — that is what the
    // fortnight window is for.
    const r = needsCall(fine({ ready_state: "not_ready", start_date: "2026-12-08" }), TODAY);
    expect(r.call).toBe(false);
  });

  it("calls out a job starting inside the fortnight that is still not ready", () => {
    const r = needsCall(fine({ ready_state: "not_ready", start_date: "2026-09-20" }), TODAY);
    expect(r.call).toBe(true);
    expect(r.reasons).toContain("not_ready");
    expect(r.daysUntilStart).toBe(12);
  });

  it("calls out a job starting soon with no windows marked arrived", () => {
    const r = needsCall(
      fine({ start_date: "2026-09-15", materials_arrived_at: null, materials_eta: "2026-09-14" }),
      TODAY,
    );
    expect(r.reasons).toEqual(["materials_missing"]);
  });

  it("calls out a missed ETA whatever the start date is", () => {
    // Late windows are late whether the job starts next week or next spring:
    // somebody has to chase the order either way.
    const r = needsCall(
      fine({ start_date: "2027-03-01", materials_eta: "2026-09-04", materials_arrived_at: null }),
      TODAY,
    );
    expect(r.reasons).toEqual(["materials_late"]);
  });

  it("stays quiet about windows that arrived after their promised day", () => {
    const r = needsCall(
      fine({ materials_eta: "2026-09-01", materials_arrived_at: "2026-09-05T12:00:00Z" }),
      TODAY,
    );
    expect(r.call).toBe(false);
  });

  it("never counts a job with no ETA as late", () => {
    expect(materialsLate(fine({ materials_eta: null, materials_arrived_at: null }), TODAY)).toBe(
      false,
    );
  });

  it("says nothing about windows nobody has promised, however soon the job starts", () => {
    // THE FIRST-MORNING RULE. materials_arrived_at is a new column: on the day
    // this ships it is null on every job in the company, because nobody has
    // ever been able to set it. If "not arrived" alone counted, the first 7 AM
    // sweep would have pushed about every job starting inside a fortnight and
    // chipped every one of those cards — all of it wrong. An ETA on file is
    // what turns a gap in the record into a fact worth calling about.
    const untouched = { ready_state: "ready", start_date: "2026-09-12" };
    expect(materialsMissing(untouched)).toBe(false);
    const r = needsCall(untouched, TODAY);
    expect(r.call).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("still calls out a job whose promised windows have not turned up", () => {
    expect(
      materialsMissing({ materials_eta: "2026-09-14", materials_arrived_at: null }),
    ).toBe(true);
  });

  it("treats a row with no pipeline columns at all as nothing to say", () => {
    // A phone running ahead of the migration: the columns simply are not in
    // the row. The Jobs page must still render, with no chip.
    const r = needsCall({}, TODAY);
    expect(r.call).toBe(false);
    expect(r.daysUntilStart).toBeNull();
  });

  it("says nothing about the GC while check-ins are unknown", () => {
    // A phone or a preview database that does not have project_gc_checkins
    // cannot ask, and "no check-in in 14 days" would then be true of every job
    // in the company — pushing about it would be pushing about nothing. Wave H
    // shipped the table; this is the guard for a database that is behind it.
    const r = needsCall(fine({ start_date: "2026-09-12" }), TODAY, null);
    expect(r.reasons).not.toContain("no_gc_checkin");
  });

  it("counts a stale or missing GC check-in once check-ins are known", () => {
    const soon = fine({ start_date: "2026-09-12" });
    expect(needsCall(soon, TODAY, "2026-09-06T09:00:00Z", true).reasons).not.toContain(
      "no_gc_checkin",
    );
    expect(needsCall(soon, TODAY, "2026-08-20T09:00:00Z", true).reasons).toContain("no_gc_checkin");
    // Known, and there has never been one.
    expect(needsCall(soon, TODAY, null, true).reasons).toContain("no_gc_checkin");
  });

  it("lists every reason that applies, in a stable order", () => {
    const r = needsCall(
      fine({
        ready_state: "not_ready",
        start_date: "2026-09-12",
        materials_eta: "2026-09-02",
        materials_arrived_at: null,
      }),
      TODAY,
    );
    expect(r.reasons).toEqual(["not_ready", "materials_missing", "materials_late"]);
  });
});

// ---------------------------------------------------------------------------
// The SQL twin. These are the clauses of claim_pipeline_nudges()'s `due` CTE
// (migration 20260979000000) written out in TypeScript. The rule lives in two
// places on purpose — the sweep must decide and claim in one statement — and
// this block is what stops the two from drifting: change one side without the
// other and this fails.
// ---------------------------------------------------------------------------
describe("dueNudges — the same rule the sweep runs in SQL", () => {
  it("warns at the far mark for a job 8 to 14 days out", () => {
    for (const day of ["2026-09-16", "2026-09-19", "2026-09-22"]) {
      const due = dueNudges(fine({ ready_state: "not_ready", start_date: day }), TODAY);
      expect(due.map((d) => d.kind)).toEqual(["start_14"]);
      expect(due[0].onDate).toBe(day);
    }
  });

  it("warns at the near mark for a job 0 to 7 days out", () => {
    for (const day of ["2026-09-08", "2026-09-11", "2026-09-15"]) {
      const due = dueNudges(fine({ ready_state: "not_ready", start_date: day }), TODAY);
      expect(due.map((d) => d.kind)).toEqual(["start_7"]);
    }
  });

  it("says nothing about a job further out than a fortnight, or already started", () => {
    expect(dueNudges(fine({ ready_state: "not_ready", start_date: "2026-09-23" }), TODAY)).toEqual(
      [],
    );
    expect(dueNudges(fine({ ready_state: "not_ready", start_date: "2026-09-07" }), TODAY)).toEqual(
      [],
    );
  });

  it("says nothing about a job starting soon that is ready with its windows in", () => {
    expect(dueNudges(fine({ start_date: "2026-09-12" }), TODAY)).toEqual([]);
  });

  it("says nothing on the first morning, when no job has a materials record yet", () => {
    // Every job in the company on deploy day: backfilled 'ready', no ETA
    // anybody could have set, nothing marked arrived. The sweep must be silent
    // — this is the burst the eta-is-not-null half of the rule prevents.
    for (const day of ["2026-09-09", "2026-09-12", "2026-09-20"]) {
      expect(
        dueNudges(
          { ready_state: "ready", start_date: day, materials_eta: null, materials_arrived_at: null },
          TODAY,
        ),
      ).toEqual([]);
    }
  });

  it("still warns when the windows were promised and are not here", () => {
    const due = dueNudges(
      {
        ready_state: "ready",
        start_date: "2026-09-12",
        materials_eta: "2026-09-11",
        materials_arrived_at: null,
      },
      TODAY,
    );
    expect(due.map((d) => d.kind)).toEqual(["start_7"]);
    expect(due[0].materialsMissing).toBe(true);
  });

  it("keys the start warning to the start date, so moving the date warns again", () => {
    const first = dueNudges(fine({ ready_state: "not_ready", start_date: "2026-09-20" }), TODAY);
    const moved = dueNudges(fine({ ready_state: "not_ready", start_date: "2026-09-21" }), TODAY);
    expect(first[0].onDate).not.toBe(moved[0].onDate);
  });

  it("keys the late-windows warning to the ETA it missed, so it is said once", () => {
    const due = dueNudges(
      fine({ start_date: "2026-11-01", materials_eta: "2026-09-04", materials_arrived_at: null }),
      TODAY,
    );
    expect(due.map((d) => d.kind)).toEqual(["materials_late"]);
    expect(due[0].onDate).toBe("2026-09-04");
    // The same job a week later still names the same missed day, so the
    // ledger's unique key refuses the second push.
    const later = dueNudges(
      fine({ start_date: "2026-11-01", materials_eta: "2026-09-04", materials_arrived_at: null }),
      "2026-09-15",
    );
    expect(later[0].onDate).toBe("2026-09-04");
  });

  it("can raise both warnings about one job on one morning", () => {
    const due = dueNudges(
      fine({
        ready_state: "not_ready",
        start_date: "2026-09-12",
        materials_eta: "2026-09-01",
        materials_arrived_at: null,
      }),
      TODAY,
    );
    expect(due.map((d) => d.kind)).toEqual(["start_7", "materials_late"]);
    expect(due[0].notReady).toBe(true);
    expect(due[0].materialsMissing).toBe(true);
  });

  it("carries the flags the push copy words itself from", () => {
    const due = dueNudges(
      fine({ ready_state: "ready", start_date: "2026-09-12", materials_arrived_at: null }),
      TODAY,
    );
    expect(due[0].notReady).toBe(false);
    expect(due[0].materialsMissing).toBe(true);
  });
});

describe("dueNudges — the GC clause the sweep gained in wave H", () => {
  // The twin of claim_pipeline_nudges()'s
  //   or c.last_checkin_day is null
  //   or c.last_checkin_day <= v_today - 14
  // added to the (a) branch beside ready_state = 'not_ready'. Change one side
  // without the other and this block goes red.
  const soon = { start_date: "2026-09-12" };

  it("warns about a job starting soon that nobody has ever called the builder about", () => {
    const due = dueNudges(fine(soon), TODAY, null, true);
    expect(due.map((d) => d.kind)).toEqual(["start_7"]);
    expect(due[0].noGcCheckin).toBe(true);
    // The other two reasons are false — this job is ready and nobody promised
    // it windows. A push that claimed otherwise is how a warning stops
    // being read.
    expect(due[0].notReady).toBe(false);
    expect(due[0].materialsMissing).toBe(false);
  });

  it("warns when the last check-in is a fortnight old, and not before", () => {
    // TODAY is 2026-09-08. Thirteen days ago is still fresh; fourteen is
    // stale. The number is GC_CHECKIN_STALE_DAYS on both sides of the wire —
    // and `v_today - 14` in claim_pipeline_nudges.
    expect(dueNudges(fine(soon), TODAY, "2026-08-26T09:00:00Z", true)).toEqual([]);
    expect(
      dueNudges(fine(soon), TODAY, "2026-08-25T09:00:00Z", true)[0]?.noGcCheckin,
    ).toBe(true);
  });

  it("says nothing about the GC on a database that cannot be asked", () => {
    // The default. A caller that has not read project_gc_checkins passes
    // nothing, and a job with no other problem raises no nudge at all.
    expect(dueNudges(fine(soon), TODAY)).toEqual([]);
  });

  it("leaves the late-windows nudge alone whatever the GC situation", () => {
    // Late windows are their own message: "the day they were due has passed".
    // Padding it with "and nobody has called the builder" would make the one
    // sentence that matters harder to read.
    const late = dueNudges(
      fine({
        start_date: "2026-12-01",
        materials_eta: "2026-08-20",
        materials_arrived_at: null,
      }),
      TODAY,
      null,
      true,
    );
    expect(late.map((d) => d.kind)).toEqual(["materials_late"]);
    expect(late[0].noGcCheckin).toBe(false);
  });
});

describe("compareProjectsForList", () => {
  const job = (over: Record<string, unknown> = {}) => ({
    name: "Job",
    job_code: "JOB",
    sort_order: null as number | null,
    start_date: null as string | null,
    ...over,
  });

  it("puts the hand-made order first", () => {
    expect(
      compareProjectsForList(job({ sort_order: 1 }), job({ sort_order: 2 })),
    ).toBeLessThan(0);
  });

  it("sorts an unplaced job after every placed one", () => {
    expect(compareProjectsForList(job({ sort_order: null }), job({ sort_order: 9 }))).toBeGreaterThan(
      0,
    );
  });

  it("falls back to the soonest start date, then to the name", () => {
    expect(
      compareProjectsForList(
        job({ start_date: "2026-09-01" }),
        job({ start_date: "2026-10-01" }),
      ),
    ).toBeLessThan(0);
    expect(compareProjectsForList(job({ name: "Alpha" }), job({ name: "Beta" }))).toBeLessThan(0);
  });

  it("sorts a job with no start date after one that has one", () => {
    expect(
      compareProjectsForList(job({ start_date: null }), job({ start_date: "2027-01-01" })),
    ).toBeGreaterThan(0);
  });

  it("compares names without case deciding it", () => {
    expect(compareProjectsForList(job({ name: "apple" }), job({ name: "Banana" }))).toBeLessThan(0);
  });

  it("falls back to the job code when a job has no name", () => {
    expect(compareProjectsForList(job({ name: "", job_code: "AAA" }), job({ name: "BBB" }))).toBeLessThan(
      0,
    );
  });

  it("orders a real list the way the Jobs page reads it", () => {
    const rows = [
      job({ name: "Zebra", sort_order: null, start_date: null }),
      job({ name: "Sand Hollow", sort_order: null, start_date: "2026-09-20" }),
      job({ name: "Pecan Valley", sort_order: 2 }),
      job({ name: "Black Desert", sort_order: 1 }),
      job({ name: "Apple", sort_order: null, start_date: null }),
    ];
    expect(sortProjectsForList(rows).map((r) => r.name)).toEqual([
      "Black Desert",
      "Pecan Valley",
      "Sand Hollow",
      "Apple",
      "Zebra",
    ]);
  });

  it("does not mutate the list it was handed", () => {
    const rows = [job({ name: "B" }), job({ name: "A" })];
    sortProjectsForList(rows);
    expect(rows.map((r) => r.name)).toEqual(["B", "A"]);
  });
});
