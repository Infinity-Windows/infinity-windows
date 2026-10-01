import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ rpc: vi.fn(), enqueue: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { rpc: m.rpc }, supabaseConfigured: true }));
vi.mock("./offline/outbox", () => ({ enqueueDailyLog: m.enqueue }));
const { fileDailyLog } = await import("./dailyLogs");

const input = { projectId: "job", logDate: "2026-10-01", headline: null, notes: "Installed frames",
  dayFlow: null, reflection: null, weather: null, baseRevision: 2 };

beforeEach(() => { m.rpc.mockReset(); m.enqueue.mockReset(); m.enqueue.mockResolvedValue("entry"); });

it("names the displayed revision on a server Save", async () => {
  m.rpc.mockResolvedValue({ data: { id: "log" }, error: null });
  expect(await fileDailyLog(input)).toMatchObject({ queued: false });
  expect(m.rpc.mock.calls[0][1]).toMatchObject({ p_expected_revision: 2 });
});

it("keeps a stale reply out of the offline queue, even when the phone says offline", async () => {
  m.rpc.mockResolvedValue({ data: null, error: { code: "40001", message: "changed" } });
  await expect(fileDailyLog(input)).rejects.toMatchObject({ code: "40001" });
  expect(m.enqueue).not.toHaveBeenCalled();
});

it("queues an unknown base instead of sending a blind replacement", async () => {
  expect(await fileDailyLog({ ...input, baseRevision: null })).toMatchObject({ queued: true });
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: null, notes: "Installed frames" }));
});
