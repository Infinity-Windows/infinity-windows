// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ sendWorkCommand: vi.fn(), getWorkUnit: vi.fn() }));
import { getWorkUnit, sendWorkCommand } from "./api";
import { dropWorkCommand, enqueueWork, enqueueWorkBatch, readWorkQueue, syncWork, retryWork, stopWorkForClock } from "./queue";
import { clockShiftResolver } from "../offline/shiftResolver";
import { finishedStop, markCompleteUnit } from "./complete";
import type { WorkCommand, WorkUnit } from "./model";
const command = {
  id: "one",
  userId: "worker-a",
  action: "stop" as const,
  data: { at: "2026-09-15T10:00:00Z" },
};
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("navigator", {
    onLine: true,
    locks: {
      request: async (_key: string, fn: () => Promise<unknown>) => fn(),
    },
  });
});
describe("durable work queue", () => {
  it("preserves a refused start and its dependent stop without blocking the next shift", async () => {
    const refused: WorkCommand = { ...command, action: "start", data: { id: "old-session", at: command.data.at } };
    const dependent: WorkCommand = { ...command, id: "old-stop", data: {
      expected_session_id: "old-session", at: "2026-09-15T10:10:00Z",
    } };
    const fresh: WorkCommand = { ...refused, id: "fresh", data: {
      id: "new-session", shift_id: "new-shift", at: "2026-09-15T10:20:00Z",
    } };
    vi.mocked(sendWorkCommand).mockRejectedValueOnce(new Error("Clock in or resume your job clock before starting work."));
    vi.mocked(sendWorkCommand).mockResolvedValue("new-session");
    await enqueueWorkBatch([refused, dependent]);
    await syncWork(command.userId);
    expect(await stopWorkForClock(command.userId, [], command.data.at)).toBe(false);
    await enqueueWork(fresh);
    await retryWork(command.userId);
    expect(vi.mocked(sendWorkCommand).mock.calls.map(([entry]) => entry.id)).toEqual(["one", "fresh"]);
    expect(readWorkQueue(command.userId)).toEqual([
      { ...refused, error: "Clock in or resume your job clock before starting work." }, dependent,
    ]);
  });
  it("keeps an offline start until the existing clock resolver confirms its shift", async () => {
    const start = { ...command, action: "start" as const, data: {
      id: "session", shift_id: "pending:offline-clock", at: command.data.at,
    } };
    await enqueueWork(start);
    expect(await syncWork("worker-a")).toBe(false);
    expect(sendWorkCommand).not.toHaveBeenCalled();
    clockShiftResolver.record("offline-clock", "real-shift");
    vi.mocked(sendWorkCommand).mockResolvedValue("session");
    expect(await syncWork("worker-a")).toBe(true);
    expect(sendWorkCommand).toHaveBeenCalledWith({ ...start, data: { ...start.data, shift_id: "real-shift" } });
  });
  it("persists new taps while a previous send is waiting and retains them after that send", async () => {
    const locks = new Map<string, Promise<void>>();
    vi.stubGlobal("navigator", { onLine: true, locks: {
      request: async (name: string, fn: () => Promise<unknown>) => {
        const preceding = locks.get(name) ?? Promise.resolve();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        locks.set(name, preceding.then(() => held));
        await preceding;
        try { return await fn(); } finally { release(); }
      },
    } });
    let finish!: (id: string) => void;
    vi.mocked(sendWorkCommand).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await enqueueWork(command);
    const sending = syncWork("worker-a");
    await vi.waitFor(() => expect(sendWorkCommand).toHaveBeenCalledTimes(1));
    await enqueueWork({ ...command, id: "next" });
    expect(readWorkQueue("worker-a").map(row => row.id)).toEqual(["one", "next"]);
    vi.mocked(sendWorkCommand).mockResolvedValue("ok");
    finish("ok");
    expect(await sending).toBe(true);
    expect(sendWorkCommand).toHaveBeenCalledTimes(2);
  });
  it("does not replay a later timer before its paid-clock boundary", async () => {
    await enqueueWork({ ...command, data: { at: "2026-09-15T11:00:00Z" } });
    expect(await syncWork("worker-a", "2026-09-15T10:00:00Z")).toBe(true);
    expect(sendWorkCommand).not.toHaveBeenCalled();
    expect(readWorkQueue("worker-a")).toHaveLength(1);
  });
  it("waits for the queued break end before starting the next activity", async () => {
    const start = { ...command, action: "start" as const, afterOutbox: ["offline-resume"],
      data: { id: "session", shift_id: "shift", at: command.data.at } };
    await enqueueWork(start);
    expect(await syncWork("worker-a")).toBe(false);
    expect(sendWorkCommand).not.toHaveBeenCalled();
    clockShiftResolver.record("workday-after:offline-resume", "sent");
    vi.mocked(sendWorkCommand).mockResolvedValue("session");
    expect(await syncWork("worker-a")).toBe(true);
    expect(sendWorkCommand).toHaveBeenCalledWith(start);
  });
  it("saves an offline activity stop at the clock-out tap and avoids a second stop on retry", async () => {
    await enqueueWork({ ...command, action: "start", data: {
      id: "session", shift_id: "pending:clock", at: "2026-09-15T09:00:00Z", project_id: "job",
    } });
    expect(await stopWorkForClock("worker-a", [], command.data.at)).toBe(true);
    expect(readWorkQueue("worker-a")[1]).toMatchObject({
      action: "stop", data: { expected_session_id: "session", at: command.data.at, outcome: "partial" },
    });
    await stopWorkForClock("worker-a", [], command.data.at);
    expect(readWorkQueue("worker-a")).toHaveLength(2);
  });
  it("persists before sending and isolates account queues", async () => {
    await enqueueWork(command);
    expect(readWorkQueue("worker-a")).toEqual([command]);
    expect(readWorkQueue("worker-b")).toEqual([]);
  });
  // 2026-11-20 (Matt): "we dont want to block the picker… overlaps are better."
  it("keeps a refused request for review, sends what was recorded after it, then retries the same ID", async () => {
    vi.mocked(sendWorkCommand).mockRejectedValueOnce(
      new Error("Current work changed"),
    );
    await enqueueWork(command);
    await enqueueWork({ ...command, id: "two" });
    vi.mocked(sendWorkCommand).mockResolvedValue("result");
    expect(await syncWork("worker-a")).toBe(false);
    expect(readWorkQueue("worker-a").map(c => c.id)).toEqual(["one"]);
    expect(readWorkQueue("worker-a")[0].error).toContain(
      "Current work changed",
    );
    expect(vi.mocked(sendWorkCommand).mock.calls.map(([c]) => c.id)).toEqual(["one", "two"]);
    expect(await retryWork("worker-a")).toBe(true);
    expect(readWorkQueue("worker-a")).toEqual([]);
    expect(vi.mocked(sendWorkCommand).mock.calls[2][0].id).toBe("one");
  });
  it("automatically retries a lost connection even while the browser says it is online", async () => {
    await enqueueWork(command);
    vi.mocked(sendWorkCommand).mockRejectedValueOnce({
      message: "TypeError: Failed to fetch",
    });
    expect(await syncWork("worker-a")).toBe(false);
    expect(readWorkQueue("worker-a")[0].error).toBeUndefined();
    vi.mocked(sendWorkCommand).mockResolvedValue("result");
    expect(await syncWork("worker-a")).toBe(true);
    expect(readWorkQueue("worker-a")).toEqual([]);
  });
  it("never reports a quota failure as a saved timer", async () => {
    const original = localStorage;
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("Quota exceeded");
      },
    });
    try {
      await expect(enqueueWork(command)).rejects.toThrow("Quota exceeded");
      expect(readWorkQueue("worker-a")).toEqual([]);
    } finally {
      vi.stubGlobal("localStorage", original);
    }
  });
  it("drops one request by id and leaves the rest, in order", async () => {
    await enqueueWork(command);
    await enqueueWork({ ...command, id: "two" });
    await enqueueWork({ ...command, id: "three" });
    await dropWorkCommand("worker-a", "two");
    expect(readWorkQueue("worker-a").map((c) => c.id)).toEqual(["one", "three"]);
    expect(readWorkQueue("worker-b")).toEqual([]);
  });
  it("leaves offline changes pending without sending", async () => {
    await enqueueWork(command);
    vi.stubGlobal("navigator", {
      onLine: false,
      locks: {
        request: async (_key: string, fn: () => Promise<unknown>) => fn(),
      },
    });
    expect(await syncWork("worker-a")).toBe(false);
    expect(sendWorkCommand).not.toHaveBeenCalled();
    expect(readWorkQueue("worker-a")).toHaveLength(1);
  });
  it("never replays an offline unit start refused later for an unsigned toolbox talk", async () => {
    const unit = { ...command, id: "unit-1", action: "unit" as const, data: { id: "new-unit", project_id: "job-1" } };
    const start = { ...command, id: "start-1", action: "start" as const, data: { id: "session-1", unit_id: "new-unit", at: "2026-09-29T08:00:00Z" } };
    await enqueueWorkBatch([unit, start]);
    vi.mocked(sendWorkCommand).mockResolvedValueOnce("ok").mockRejectedValueOnce(
      new Error("Sign today's toolbox talk before starting work on a unit."),
    );
    expect(await syncWork("worker-a")).toBe(false);
    expect(readWorkQueue("worker-a")[0]).toMatchObject({ id: "start-1", error: expect.stringContaining("toolbox talk") });
    vi.mocked(sendWorkCommand).mockResolvedValue("ok");
    expect(await retryWork("worker-a")).toBe(true);
    expect(readWorkQueue("worker-a")).toEqual([]);
    expect(vi.mocked(sendWorkCommand).mock.calls.map(([c]) => c.id)).toEqual(["unit-1", "start-1"]);
  });
});

// "Unit complete" is a stop plus the unit's complete mark. Codex's review of
// #648 (2026-09-24) proved the mark was lost when the app closed between the
// stop's network wait and the mark being queued. Every boundary below is a
// reload: the queue is re-read from storage, as a relaunched app would.
describe("a unit created on the phone", () => {
  const write = { editId: "e1", projectId: "job-1", id: "new-opening", create: true, code: "9-9", details: {}, previousCode: null, previousDetails: {} };
  const create: WorkCommand = { id: "create", userId: "worker-a", action: "unit_create", data: write };
  const unit: WorkCommand = { id: "unit", userId: "worker-a", action: "unit",
    data: { id: "work-unit", project_id: "job-1", opening_id: "new-opening", label: "9-9", facts: {} } };
  const start: WorkCommand = { id: "start", userId: "worker-a", action: "start",
    data: { id: "session", unit_id: "work-unit", at: "2026-11-20T15:00:00Z" } };

  it("is sent before the timer that was started on it", async () => {
    vi.mocked(sendWorkCommand).mockResolvedValue("ok");
    await enqueueWorkBatch([create, unit, start]);
    await syncWork("worker-a");
    expect(vi.mocked(sendWorkCommand).mock.calls.map(([c]) => c.action)).toEqual(["unit_create", "unit", "start"]);
    expect(readWorkQueue("worker-a")).toEqual([]);
  });

  it("keeps the clocked time for review when Forge refuses the unit", async () => {
    vi.mocked(sendWorkCommand).mockRejectedValueOnce(new Error("This job already has a unit with that number."));
    vi.mocked(sendWorkCommand).mockResolvedValue("ok");
    await enqueueWorkBatch([create, unit, start]);
    await syncWork("worker-a");
    const sent = vi.mocked(sendWorkCommand).mock.calls.map(([c]) => c);
    expect(sent.map(c => c.action)).toEqual(["unit_create", "unit", "start"]);
    // The work record no longer points at the unit that was never created,
    // and says so in its name; the timer is saved on it as tapped.
    expect(sent[1].data).toMatchObject({ id: "work-unit", opening_id: null, label: "9-9 (unit not created)",
      facts: { unit_not_created: "This job already has a unit with that number." } });
    expect(sent[2].data).toMatchObject({ unit_id: "work-unit", at: "2026-11-20T15:00:00Z" });
    expect(readWorkQueue("worker-a")).toEqual([]);
  });

  it("waits, with its timer, while there is no signal", async () => {
    vi.mocked(sendWorkCommand).mockRejectedValue(new TypeError("Failed to fetch"));
    await enqueueWorkBatch([create, unit, start]);
    await syncWork("worker-a");
    expect(readWorkQueue("worker-a").map(c => c.action)).toEqual(["unit_create", "unit", "start"]);
    expect(readWorkQueue("worker-a").some(c => c.error)).toBe(false);
  });
});
describe("Unit complete survives weak signal and reloads", () => {
  const unit: WorkUnit = {
    id: "u4", project_id: "job-1", opening_id: null, created_by: "worker-a", label: "4", type_label: "Bifold door",
    revision: 3, created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:00:00Z",
    facts: { width_in: 72, height_in: 96 },
  };
  const active = { id: "s1", description: "Set the frame" };
  const completion = (): WorkCommand[] => [
    { id: "stop-1", userId: "worker-a", action: "stop", data: finishedStop(active, "2026-09-24T15:00:00Z", "", "") },
    { id: "mark-1", userId: "worker-a", action: "unit", data: markCompleteUnit(unit), intent: "complete-unit" },
  ];
  const lost = { message: "TypeError: Failed to fetch" };

  it("saves both steps in one write before anything is sent", async () => {
    const writes = vi.spyOn(localStorage, "setItem");
    await enqueueWorkBatch(completion());
    expect(writes).toHaveBeenCalledTimes(1);
    expect(sendWorkCommand).not.toHaveBeenCalled();
    // Reload before any reply: both are still on the device, in order.
    expect(readWorkQueue("worker-a").map((c) => c.id)).toEqual(["stop-1", "mark-1"]);
    writes.mockRestore();
  });

  it("finishes the job after the stop committed but its reply was lost, then a reload", async () => {
    await enqueueWorkBatch(completion());
    vi.mocked(sendWorkCommand).mockRejectedValueOnce(lost); // committed server-side, reply lost
    expect(await syncWork("worker-a")).toBe(false);
    expect(readWorkQueue("worker-a").map((c) => c.id)).toEqual(["stop-1", "mark-1"]);
    // Relaunch: the stop's retry is answered by its idempotent id, then the mark goes.
    vi.mocked(sendWorkCommand).mockResolvedValue("ok");
    expect(await syncWork("worker-a")).toBe(true);
    expect(vi.mocked(sendWorkCommand).mock.calls.map(([c]) => c.id)).toEqual(["stop-1", "stop-1", "mark-1"]);
    expect(readWorkQueue("worker-a")).toEqual([]);
  });

  it("keeps the mark when the stop went through and the mark's reply was lost", async () => {
    await enqueueWorkBatch(completion());
    vi.mocked(sendWorkCommand).mockResolvedValueOnce("ok").mockRejectedValueOnce(lost);
    expect(await syncWork("worker-a")).toBe(false);
    expect(readWorkQueue("worker-a").map((c) => c.id)).toEqual(["mark-1"]);
    vi.mocked(sendWorkCommand).mockResolvedValue("ok");
    expect(await syncWork("worker-a")).toBe(true);
    expect(readWorkQueue("worker-a")).toEqual([]);
  });

  it("when someone changed the unit meanwhile, rebuilds the mark from the latest copy and keeps their edits", async () => {
    await enqueueWorkBatch(completion());
    const theirs = { ...unit, revision: 5, facts: { ...unit.facts, story: "2", note: "Foreman added access notes" } };
    vi.mocked(getWorkUnit).mockResolvedValue(theirs);
    vi.mocked(sendWorkCommand)
      .mockResolvedValueOnce("ok")
      .mockRejectedValueOnce({ code: "P0001", message: "Unit details changed. Refresh before saving." })
      .mockResolvedValue("ok");
    expect(await syncWork("worker-a")).toBe(true);
    const resent = vi.mocked(sendWorkCommand).mock.calls[2][0];
    expect(resent.id).not.toBe("mark-1");
    expect(resent.rebased).toBe(true);
    expect(resent.data.revision).toBe(5);
    expect(resent.data.facts).toEqual({ ...theirs.facts, installation_complete: "Yes" });
    expect(readWorkQueue("worker-a")).toEqual([]);
  });

  it("drops the mark quietly when someone already marked the unit complete", async () => {
    await enqueueWorkBatch(completion());
    vi.mocked(getWorkUnit).mockResolvedValue({ ...unit, revision: 4, facts: { ...unit.facts, installation_complete: "Yes" } });
    vi.mocked(sendWorkCommand)
      .mockResolvedValueOnce("ok")
      .mockRejectedValueOnce({ code: "P0001", message: "Unit details changed. Refresh before saving." });
    expect(await syncWork("worker-a")).toBe(true);
    expect(sendWorkCommand).toHaveBeenCalledTimes(2);
    expect(readWorkQueue("worker-a")).toEqual([]);
  });

  it("rebuilds at most once, then keeps the refusal for review", async () => {
    await enqueueWorkBatch(completion());
    vi.mocked(getWorkUnit).mockResolvedValue({ ...unit, revision: 5 });
    vi.mocked(sendWorkCommand)
      .mockResolvedValueOnce("ok")
      .mockRejectedValue({ code: "P0001", message: "Unit details changed. Refresh before saving." });
    expect(await syncWork("worker-a")).toBe(false);
    const left = readWorkQueue("worker-a");
    expect(left).toHaveLength(1);
    expect(left[0].rebased).toBe(true);
    expect(left[0].error).toContain("Unit details changed");
  });

  it("waits, keeping the original mark, when the fresh read itself hits no signal", async () => {
    await enqueueWorkBatch(completion());
    vi.mocked(getWorkUnit).mockRejectedValue(lost);
    vi.mocked(sendWorkCommand)
      .mockResolvedValueOnce("ok")
      .mockRejectedValueOnce({ code: "P0001", message: "Unit details changed. Refresh before saving." });
    expect(await syncWork("worker-a")).toBe(false);
    const left = readWorkQueue("worker-a");
    expect(left.map((c) => c.id)).toEqual(["mark-1"]);
    expect(left[0].error).toBeUndefined();
  });

  it("other refusals of a completion are kept for review, never rebuilt", async () => {
    await enqueueWorkBatch(completion());
    vi.mocked(sendWorkCommand)
      .mockResolvedValueOnce("ok")
      .mockRejectedValueOnce({ code: "P0001", message: "Only the author or a foreman can edit this unit." });
    expect(await syncWork("worker-a")).toBe(false);
    expect(getWorkUnit).not.toHaveBeenCalled();
    expect(readWorkQueue("worker-a")[0].error).toContain("Only the author");
  });
});
