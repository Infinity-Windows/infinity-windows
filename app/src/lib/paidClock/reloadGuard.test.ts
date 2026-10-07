// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn } from "../signedIn";
const read = vi.hoisted(() => vi.fn());
vi.mock("./storage", () => ({ readPaidClockRecords: read }));
const guard = await import("./reloadGuard");
const OWNER="00000000-0000-4000-8000-000000000001";
beforeEach(() => { rememberSignedIn({user:{id:OWNER}}); read.mockReset(); });
describe("native payroll reload hold", () => {
  it("counts unresolved delivery and fails closed for unread or foreign storage", async () => {
    read.mockResolvedValue(["queued","sending","uncertain","attention","acknowledged"].map(status => ({ownerId:OWNER,delivery:{status}})));
    expect(await guard.readPaidClockReloadHold(OWNER)).toBe(3);
    read.mockRejectedValueOnce(Error("corrupt store")); expect(await guard.readPaidClockReloadHold(OWNER)).toBe(1);
    read.mockResolvedValueOnce([{ownerId:"another owner",delivery:{status:"acknowledged"}}]);
    expect(await guard.readPaidClockReloadHold(OWNER)).toBe(1);
    expect(await guard.readPaidClockReloadHold(null)).toBe(0);
  });
  it("does not accept an empty result from an earlier login generation", async () => {
    let resolve!: (rows: unknown[]) => void;
    read.mockImplementationOnce(() => new Promise(done => {resolve=done;}));
    const pending=guard.readPaidClockReloadHold(OWNER);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    rememberSignedIn(null); rememberSignedIn({user:{id:OWNER}});
    resolve([]); expect(await pending).toBe(1);
  });
  it("holds reload when native storage never answers instead of hanging the reload check",async()=>{
    vi.useFakeTimers();
    try {
      read.mockImplementationOnce(()=>new Promise(()=>{}));
      const pending=guard.readPaidClockReloadHold(OWNER);
      await vi.advanceTimersByTimeAsync(2_001);
      expect(await pending).toBe(1);
    } finally {vi.useRealTimers();}
  });
  it("retains aggregate busy across logout and a caller deadline until the underlying request settles", async () => {
    let resolve!: () => void;
    const actual=guard.trackPaidClockOperation(() => new Promise<void>(done => {resolve=done;}));
    expect(guard.paidClockOperationInFlight()).toBe(true);
    await Promise.race([actual,Promise.resolve("caller timed out")]);
    rememberSignedIn(null);
    expect(guard.paidClockOperationInFlight()).toBe(true);
    const finish=guard.beginPaidClockOperation();
    resolve(); await actual;
    expect(guard.paidClockOperationInFlight()).toBe(true);
    finish(); finish(); expect(guard.paidClockOperationInFlight()).toBe(false);
  });
});
