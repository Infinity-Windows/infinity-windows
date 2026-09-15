// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ sendWorkCommand: vi.fn() }));
import { sendWorkCommand } from "./api";
import { enqueueWork, readWorkQueue, syncWork, retryWork } from "./queue";
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
