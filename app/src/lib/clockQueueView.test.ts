// K0.1, the rules: what the clock shows when punches are still on the phone.
//
// A clock-in tapped in a dead zone is a shift from the moment it was tapped;
// a queued break and clock-out move that shift the way the server will; a
// punch the queue gave up on is NOT applied and comes back as refused; and
// once the server has a punch, its row wins over the phone's copy.

import { describe, expect, it } from "vitest";
import {
  confirmedOpenShift,
  mergeClockQueue,
  pendingEntryIdOf,
  type ClockNameLookups,
} from "./clockQueueView";
import { deserializeEntry, serializeEntry, type OutboxEntry } from "./offline/outbox-core";
import type { TimeShift } from "./timeclock";

const T = (h: number, m: number) => `2026-09-23T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

function entry(over: Partial<OutboxEntry> & { op: OutboxEntry["op"] }): OutboxEntry {
  return {
    id: over.id ?? `${over.op}-1`,
    op: over.op,
    payload: over.payload ?? {},
    createdAt: over.createdAt ?? 0,
    attemptCount: 0,
    lastError: over.lastError ?? null,
    status: over.status ?? "queued",
    nextAttemptAt: 0,
    dependsOn: over.dependsOn ?? null,
    hasBlob: false,
  };
}

const CLIENT = "9b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b77";

function queuedClockIn(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return entry({
    op: "clock_in",
    id: "x",
    createdAt: 1,
    payload: {
      projectId: "p1",
      costCodeId: "cc1",
      lat: 40.1,
      lng: -111.9,
      note: "gate 4411",
      mode: "tracking",
      clientId: CLIENT,
      tappedAt: T(13, 2),
      clockCheckedAt: null,
      clockSkewMs: null,
    },
    ...over,
  });
}

function serverShift(over: Partial<TimeShift> = {}): TimeShift {
  return {
    id: "s1",
    profile_id: "me",
    project_id: "p1",
    cost_code_id: "cc1",
    clock_in_at: T(12, 55),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: T(12, 55),
    projects: { job_code: "BLACK22", name: "Black Desert" },
    cost_codes: { code: "100", label: "Install" },
    ...over,
  };
}

const lookups: ClockNameLookups = {
  project: (id) => (id === "p1" ? { job_code: "BLACK22", name: "Black Desert" } : null),
  costCode: (id) => (id === "cc1" ? { code: "100", label: "Install" } : null),
};

describe("a clock-in still on the phone", () => {
  it("shows as clocked in from the tap time, on the picked job, under a pending id", () => {
    const view = mergeClockQueue(null, [queuedClockIn()], { profileId: "me", lookups });
    expect(view.shift).toMatchObject({
      id: "pending:x",
      client_id: CLIENT,
      profile_id: "me",
      project_id: "p1",
      cost_code_id: "cc1",
      clock_in_at: T(13, 2),
      status: "open",
      break_started_at: null,
      note: "gate 4411",
      job_mode: "tracking",
      clock_in_lat: 40.1,
      projects: { job_code: "BLACK22", name: "Black Desert" },
      cost_codes: { code: "100", label: "Install" },
    });
    expect(view.pending).toEqual({ kind: "clock_in", entryId: "x", tappedAt: T(13, 2), sending: false });
    expect(view.refused).toEqual([]);
  });

  it("is what the screens see whether the server has answered nothing yet or answered 'no shift'", () => {
    const fromNothing = mergeClockQueue(undefined, [queuedClockIn()], { profileId: "me" });
    const fromEmpty = mergeClockQueue(null, [queuedClockIn()], { profileId: "me" });
    expect(fromNothing.shift?.id).toBe("pending:x");
    expect(fromEmpty.shift?.id).toBe("pending:x");
    // No job list on hand: the shift still stands, just without its names.
    expect(fromEmpty.shift?.projects).toBeNull();
  });

  it("replaces an older open shift the clock-in will close (a switch made with no signal)", () => {
    const view = mergeClockQueue(serverShift(), [queuedClockIn()], { profileId: "me", lookups });
    expect(view.shift?.id).toBe("pending:x");
    expect(view.shift?.clock_in_at).toBe(T(13, 2));
  });

  it("reads as 'sending' while the drain is attempting it", () => {
    const view = mergeClockQueue(null, [queuedClockIn({ status: "sending" })], { profileId: "me" });
    expect(view.pending?.sending).toBe(true);
    expect(view.shift?.id).toBe("pending:x");
  });

  it("gives way to the server's row once the server has THIS tap (the reply was lost, the queue is resending)", () => {
    const confirmed = serverShift({ client_id: CLIENT, clock_in_at: T(13, 2) });
    const view = mergeClockQueue(confirmed, [queuedClockIn()], { profileId: "me", lookups });
    expect(view.shift).toBe(confirmed);
    // The queue still holds it, so the line still says it is on its way.
    expect(view.pending?.kind).toBe("clock_in");
  });

  it("counts from the moment it was queued when the entry predates tap times", () => {
    const old = queuedClockIn({ payload: { projectId: "p1", costCodeId: "cc1", clientId: CLIENT }, createdAt: Date.UTC(2026, 8, 23, 13, 2) });
    const view = mergeClockQueue(null, [old], { profileId: "me" });
    expect(view.shift?.clock_in_at).toBe(T(13, 2));
  });
});

describe("a break and a clock-out still on the phone", () => {
  const breakStart = (shiftRef: string, at = T(12, 0)) =>
    entry({ op: "break_start", id: "b1", createdAt: 2, payload: { shiftRef, breakType: "lunch", tappedAt: at } });
  const breakStop = (shiftRef: string, at = T(12, 30)) =>
    entry({ op: "break_stop", id: "b2", createdAt: 3, payload: { shiftRef, tappedAt: at } });
  const clockOut = (shiftRef: string, at = T(16, 2)) =>
    entry({ op: "clock_out", id: "o1", createdAt: 4, payload: { shiftRef, tappedAt: at } });

  it("a queued break start shows the person on break from its tap", () => {
    const view = mergeClockQueue(serverShift(), [breakStart("s1")], { profileId: "me" });
    expect(view.shift).toMatchObject({ id: "s1", break_started_at: T(12, 0), break_type: "lunch" });
    expect(view.pending?.kind).toBe("break_start");
  });

  it("a queued break end shows the person back at work, with the break banked — never a stale 'on break'", () => {
    const onBreak = serverShift({ break_started_at: T(12, 0), break_type: "lunch", break_seconds: 300 });
    const view = mergeClockQueue(onBreak, [breakStop("s1")], { profileId: "me" });
    expect(view.shift).toMatchObject({ id: "s1", break_started_at: null, break_type: null, break_seconds: 300 + 30 * 60 });
    expect(view.pending?.kind).toBe("break_stop");
  });

  it("a queued clock-out shows the person off the clock — never a second clock-out", () => {
    const view = mergeClockQueue(serverShift(), [clockOut("s1")], { profileId: "me" });
    expect(view.shift).toBeNull();
    expect(view.pending).toEqual({ kind: "clock_out", entryId: "o1", tappedAt: T(16, 2), sending: false });
  });

  it("the whole day on the phone: clock-in, break, back, clock-out, in tap order whatever order the store lists them", () => {
    const day = [clockOut("pending:x"), breakStop("pending:x"), queuedClockIn(), breakStart("pending:x")];
    const view = mergeClockQueue(null, day, { profileId: "me" });
    expect(view.shift).toBeNull();
    expect(view.pending?.kind).toBe("clock_out");

    const stillWorking = mergeClockQueue(null, day.filter((e) => e.op !== "clock_out"), { profileId: "me" });
    expect(stillWorking.shift).toMatchObject({ id: "pending:x", break_started_at: null, break_seconds: 30 * 60 });
    expect(stillWorking.pending?.kind).toBe("break_stop");
  });

  it("leaves a shift alone when the queued punch belongs to some other shift", () => {
    const view = mergeClockQueue(serverShift({ id: "s2" }), [breakStart("s1"), clockOut("s1")], { profileId: "me" });
    expect(view.shift?.id).toBe("s2");
    expect(view.shift?.break_started_at).toBeNull();
    // Still on the phone, still said.
    expect(view.pending?.kind).toBe("clock_out");
  });

  it("does not double a break the server already shows running", () => {
    const onBreak = serverShift({ break_started_at: T(11, 58), break_type: "rest" });
    const view = mergeClockQueue(onBreak, [breakStart("s1")], { profileId: "me" });
    expect(view.shift?.break_started_at).toBe(T(11, 58));
    expect(view.shift?.break_type).toBe("rest");
  });
});

describe("a punch the phone gave up on", () => {
  it("is not applied, and is reported with its reason so the person can read why", () => {
    const refused = queuedClockIn({ status: "failed", lastError: "Sign today's toolbox talk first." });
    const view = mergeClockQueue(null, [refused], { profileId: "me" });
    expect(view.shift).toBeNull();
    expect(view.pending).toBeNull();
    expect(view.refused).toEqual([
      { kind: "clock_in", entryId: "x", tappedAt: T(13, 2), reason: "Sign today's toolbox talk first." },
    ]);
  });

  it("strands what waited on it as refused too, while the server's own shift still stands", () => {
    const failedIn = queuedClockIn({ status: "failed", lastError: "no" });
    const strandedOut = entry({
      op: "clock_out",
      id: "o1",
      createdAt: 4,
      status: "failed",
      dependsOn: "x",
      lastError: "The clock-in this was waiting on failed, so this could never be sent.",
      payload: { shiftRef: "pending:x", tappedAt: T(16, 2) },
    });
    const view = mergeClockQueue(serverShift(), [failedIn, strandedOut], { profileId: "me" });
    expect(view.shift?.id).toBe("s1");
    expect(view.refused.map((r) => r.kind)).toEqual(["clock_in", "clock_out"]);
  });
});

describe("after a reload", () => {
  it("reads the same state back off the serialized rows the store kept", () => {
    const rows = [queuedClockIn(), entry({ op: "break_start", id: "b1", createdAt: 2, payload: { shiftRef: "pending:x", breakType: "lunch", tappedAt: T(12, 0) } })]
      .map(serializeEntry)
      .map((json) => deserializeEntry(json)!);
    const view = mergeClockQueue(undefined, rows, { profileId: "me", lookups });
    expect(view.shift).toMatchObject({ id: "pending:x", clock_in_at: T(13, 2), break_started_at: T(12, 0), projects: { job_code: "BLACK22" } });
    expect(view.pending?.kind).toBe("break_start");
  });

  it("ignores everything that is not a punch", () => {
    const photo = entry({ op: "photo_upload", id: "ph", createdAt: 5, payload: { path: "a.jpg" } });
    const view = mergeClockQueue(serverShift(), [photo], { profileId: "me" });
    expect(view.shift?.id).toBe("s1");
    expect(view.pending).toBeNull();
  });
});

describe("confirmedOpenShift (what a sent punch leaves as the server's shift)", () => {
  it("a confirmed clock-in, break start or break end is the row the server answered", () => {
    const row = serverShift({ client_id: CLIENT });
    expect(confirmedOpenShift("clock_in", row)).toBe(row);
    expect(confirmedOpenShift("break_start", { ...row, break_started_at: T(12, 0) })).toMatchObject({ break_started_at: T(12, 0) });
    expect(confirmedOpenShift("break_stop", row)).toBe(row);
  });

  it("a confirmed clock-out leaves no open shift, whatever the row says", () => {
    expect(confirmedOpenShift("clock_out", serverShift({ clock_out_at: T(16, 2), status: "submitted" }))).toBeNull();
    expect(confirmedOpenShift("clock_out", undefined)).toBeNull();
  });

  it("an answer that is not a shift row leaves the cache alone", () => {
    expect(confirmedOpenShift("clock_in", null)).toBeUndefined();
    expect(confirmedOpenShift("clock_in", { outcome: "ended" })).toBeUndefined();
    expect(confirmedOpenShift("break_stop", "ok")).toBeUndefined();
  });

  it("a row that came back already closed is no open shift", () => {
    expect(confirmedOpenShift("break_stop", serverShift({ clock_out_at: T(16, 2), status: "submitted" }))).toBeNull();
  });
});

describe("pendingEntryIdOf", () => {
  it("reads the entry id out of a pending ref and nothing out of a real id", () => {
    expect(pendingEntryIdOf("pending:abc")).toBe("abc");
    expect(pendingEntryIdOf("s1")).toBeNull();
    expect(pendingEntryIdOf(null)).toBeNull();
  });
});
