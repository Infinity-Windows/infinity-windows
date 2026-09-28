// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ sendWorkCommand: vi.fn(), getWorkUnit: vi.fn() }));
import { getWorkUnit, sendWorkCommand } from "./api";
import { dropWorkCommand, enqueueWork, enqueueWorkBatch, readWorkQueue, syncWork, retryWork } from "./queue";
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
  it("persists before sending and isolates account queues", async () => {
    await enqueueWork(command);
    expect(readWorkQueue("worker-a")).toEqual([command]);
    expect(readWorkQueue("worker-b")).toEqual([]);
  });
  it("keeps a refused request and everything behind it, then retries the same ID", async () => {
    vi.mocked(sendWorkCommand).mockRejectedValueOnce(
      new Error("Current work changed"),
    );
    await enqueueWork(command);
    await enqueueWork({ ...command, id: "two" });
    expect(await syncWork("worker-a")).toBe(false);
    expect(readWorkQueue("worker-a")).toHaveLength(2);
    expect(readWorkQueue("worker-a")[0].error).toContain(
      "Current work changed",
    );
    vi.mocked(sendWorkCommand).mockResolvedValue("result");
    expect(await retryWork("worker-a")).toBe(true);
    expect(readWorkQueue("worker-a")).toEqual([]);
    expect(vi.mocked(sendWorkCommand).mock.calls[1][0].id).toBe("one");
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
});

// "Unit complete" is a stop plus the unit's complete mark. Codex's review of
// #648 (2026-09-24) proved the mark was lost when the app closed between the
// stop's network wait and the mark being queued. Every boundary below is a
// reload: the queue is re-read from storage, as a relaunched app would.
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

