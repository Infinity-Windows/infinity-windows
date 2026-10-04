// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
import type { ClockIntent } from "./protocol";
const m = vi.hoisted(() => ({ session: vi.fn(), rpc: vi.fn(), token: vi.fn(), single: vi.fn(), eq: vi.fn(), select: vi.fn(), from: vi.fn() }));
vi.mock("../supabase", () => ({ supabase: { auth: { getSession: m.session } }, clientWithToken: m.token }));
const api = await import("./api");
const OWNER = "00000000-0000-4000-8000-000000000001", SHIFT = "00000000-0000-4000-8000-000000000002", CLIENT = "00000000-0000-4000-8000-000000000003";
const intent: ClockIntent = { action: "clock_in", clientId: CLIENT, tappedAt: "2026-10-04T08:00:00.000Z", clockCheckedAt: null,
  clockSkewMs: null, projectId: null, costCodeId: null, photo: null, lat: null, lng: null, note: null, mode: null, setupVersion: 1 };
beforeEach(() => {
  for (const mock of Object.values(m)) mock.mockReset();
  rememberSignedIn({ user: { id: OWNER } });
  m.session.mockResolvedValue({ data: { session: { access_token: "synthetic-fixed-token", user: { id: OWNER } } }, error: null });
  m.rpc.mockResolvedValue({ data: { status: "open", id: SHIFT }, error: null });
  m.single.mockResolvedValue({ data: { id: SHIFT, profile_id: OWNER, status: "open", clock_out_at: null }, error: null });
  const query = { eq: m.eq, maybeSingle: m.single }; m.eq.mockReturnValue(query); m.select.mockReturnValue(query);
  m.from.mockReturnValue({ select: m.select }); m.token.mockReturnValue({ rpc: m.rpc, from: m.from });
});
describe("isolated clock API", () => {
  it("binds the actual token and sends all twelve original arguments once", async () => {
    await api.sendPaidClockIntent(intent, signInMark());
    expect(m.token).toHaveBeenCalledWith("synthetic-fixed-token");
    expect(m.rpc).toHaveBeenCalledOnce();
    expect(m.rpc).toHaveBeenCalledWith("clock_in", { p_project_id: null, p_cost_code_id: null, p_photo: null, p_lat: null, p_lng: null,
      p_note: null, p_mode: null, p_client_id: CLIENT, p_tapped_at: intent.tappedAt, p_clock_checked_at: null, p_clock_skew_ms: null, p_setup_version: 1 });
  });
  it("never downgrades a missing twelve-argument overload to eleven", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } });
    await expect(api.sendPaidClockIntent(intent, signInMark())).rejects.toBeInstanceOf(api.ClockRequestRefusedError);
    expect(m.rpc).toHaveBeenCalledOnce();
  });
  it("does not send after account ABA while obtaining the token", async () => {
    let resolve!: (v: unknown) => void; m.session.mockImplementation(() => new Promise(done => { resolve = done; }));
    const request = api.sendPaidClockIntent(intent, signInMark());
    rememberSignedIn(null); rememberSignedIn({ user: { id: OWNER } });
    resolve({ data: { session: { access_token: "old-token", user: { id: OWNER } } }, error: null });
    await expect(request).rejects.toBeInstanceOf(api.ClockAccountChangedError); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("rejects a late receipt after account ABA", async () => {
    let resolve!: (v: unknown) => void; m.rpc.mockImplementation(() => new Promise(done => { resolve = done; }));
    const request = api.readPaidClockReceipt(intent, signInMark()); await Promise.resolve(); await Promise.resolve();
    rememberSignedIn(null); rememberSignedIn({ user: { id: OWNER } });
    resolve({ data: { protocolVersion: 1, availability: "unavailable", receipt: null }, error: null });
    await expect(request).rejects.toBeInstanceOf(api.ClockAccountChangedError);
  });
  it("creates runtime safety evidence only from an exact fresh self-owned open shift", async () => {
    const login = signInMark(), basis = await api.fetchOwnClockSafetyBasis(SHIFT, login);
    expect(m.eq).toHaveBeenCalledWith("profile_id", OWNER);
    expect(api.isCurrentClockSafetyBasis(basis, OWNER, SHIFT, login)).toBe(true);
    expect(api.isCurrentClockSafetyBasis({ ...basis }, OWNER, SHIFT, login)).toBe(false);
    rememberSignedIn(null); rememberSignedIn({ user: { id: OWNER } });
    expect(api.isCurrentClockSafetyBasis(basis, OWNER, SHIFT, signInMark())).toBe(false);
  });
  it("refuses foreign, closed or reviewed source rows", async () => {
    for (const row of [{ id: SHIFT, profile_id: CLIENT, status: "open", clock_out_at: null },
      { id: SHIFT, profile_id: OWNER, status: "closed", clock_out_at: "2026-10-04T09:00:00Z" },
      { id: SHIFT, profile_id: OWNER, status: "needs_finish", clock_out_at: null }]) {
      m.single.mockResolvedValue({ data: row, error: null });
      await expect(api.fetchOwnClockSafetyBasis(SHIFT, signInMark())).rejects.toThrow("unavailable");
    }
  });
  it("checks admission after awaiting the token and before handing RPC off",async()=>{
    let resolve!:(v:unknown)=>void,admitted=true;m.session.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const request=api.sendPaidClockIntent(intent,signInMark(),undefined,()=>admitted);
    admitted=false;resolve({data:{session:{access_token:"fixed",user:{id:OWNER}}},error:null});
    await expect(request).rejects.toBeInstanceOf(api.ClockPreDispatchVetoError);expect(m.rpc).not.toHaveBeenCalled();
  });
  it("does not label generic token or transport errors as a known pre-dispatch veto",async()=>{
    m.session.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(api.sendPaidClockIntent(intent,signInMark(),undefined,()=>true)).rejects.not.toBeInstanceOf(api.ClockPreDispatchVetoError);expect(m.rpc).not.toHaveBeenCalled();
    m.rpc.mockRejectedValueOnce(new TypeError("reply lost"));
    await expect(api.sendPaidClockIntent(intent,signInMark(),undefined,()=>true)).rejects.not.toBeInstanceOf(api.ClockPreDispatchVetoError);expect(m.rpc).toHaveBeenCalledOnce();
  });

});
