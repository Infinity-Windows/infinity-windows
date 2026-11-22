import { beforeEach, expect, it, vi } from "vitest";
import {rememberSignedIn} from "./signedIn";
import { emptyProgressFields } from "./dailyLogStages";

const m = vi.hoisted(() => ({ rpc: vi.fn(), enqueue: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { rpc: m.rpc }, supabaseConfigured: true }));
vi.mock("./offline/outbox", () => ({ enqueueDailyLog: m.enqueue }));
const { fileDailyLog, isStaleDailyLogError } = await import("./dailyLogs");

const input = { projectId: "job", logDate: "2026-10-01", headline: null, notes: "Installed frames",
  dayFlow: null, reflection: null, weather: null, baseRevision: 2, ...emptyProgressFields() };

beforeEach(() => { m.rpc.mockReset(); m.enqueue.mockReset(); m.enqueue.mockResolvedValue("entry"); });

it("names the displayed revision on a server Save", async () => {
  m.rpc.mockResolvedValue({ data: { id: "log" }, error: null });
  expect(await fileDailyLog(input)).toMatchObject({ queued: false });
  expect(m.rpc.mock.calls[0][1]).toMatchObject({ p_expected_revision: 2 });
});

it.each(["PT409", "40001"])("keeps a %s stale reply out of the offline queue", async (code) => {
  m.rpc.mockResolvedValue({ data: null, error: { code, message: "changed" } });
  await expect(fileDailyLog(input)).rejects.toMatchObject({ code });
  expect(m.enqueue).not.toHaveBeenCalled();
});

it("queues an unknown base instead of sending a blind replacement", async () => {
  expect(await fileDailyLog({ ...input, baseRevision: null })).toMatchObject({ queued: true });
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: null, notes: "Installed frames" }));
});

it("network fallback retains the author across a sign-in change",async()=>{
  rememberSignedIn({user:{id:"author-a",email:"a@test.example"}});
  let reject!:(e:unknown)=>void;
  m.rpc.mockReturnValue(new Promise((_r,rej)=>{reject=rej;}));
  const saving=fileDailyLog({...input,reviewedConflict:"author-a-review"});
  rememberSignedIn({user:{id:"author-b",email:"b@test.example"}});
  reject(new TypeError("Failed to fetch"));
  expect(await saving).toMatchObject({queued:true});
  expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ownerId:"author-a",reviewedConflict:"author-a-review"}));
  rememberSignedIn(null);
});

it.each([null, {}, { code: "42501" }, { code: "P0001" }])("does not classify another error as stale: %j", (error) => {
  expect(isStaleDailyLogError(error)).toBe(false);
});
