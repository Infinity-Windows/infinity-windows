import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn } from "../signedIn";

const mocks = vi.hoisted(() => ({ session: vi.fn(), sharedRpc: vi.fn(), boundRpc: vi.fn(), client: vi.fn() }));
vi.mock("../supabase", () => ({
  supabase: { auth: { getSession: mocks.session }, rpc: mocks.sharedRpc },
  clientWithToken: mocks.client,
}));
import { sendWorkCommand } from "./api";
import type { WorkCommand } from "./model";
const command: WorkCommand = { id: "unchanged-retry-id", userId: "anna", action: "start", data: { project_id: "job" } };
const session = { data: { session: { access_token: "anna-token", user: { id: "anna" } } }, error: null };
function signIn(id: string | null) { rememberSignedIn(id ? { user: { id } } : null); }
beforeEach(() => {
  vi.clearAllMocks(); signIn(null); signIn("anna");
  mocks.session.mockResolvedValue(session);
  mocks.client.mockReturnValue({ rpc: mocks.boundRpc });
  mocks.boundRpc.mockResolvedValue({ data: "result", error: null });
});
describe("work command account ownership", () => {
  it("sends only through the verified owner's fixed-token client", async () => {
    expect(await sendWorkCommand(command)).toBe("result");
    expect(mocks.client).toHaveBeenCalledExactlyOnceWith("anna-token");
    expect(mocks.sharedRpc).not.toHaveBeenCalled();
    expect(mocks.boundRpc).toHaveBeenCalledExactlyOnceWith("custom_work_command", { p_id: command.id, p_action: "start", p_data: command.data });
  });
  it("does not refresh or send another owner's queued command", async () => {
    signIn("ben");
    await expect(sendWorkCommand(command)).rejects.toThrow("account that recorded");
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.boundRpc).not.toHaveBeenCalled();
  });
  it("refuses an identity change while getSession refreshes", async () => {
    mocks.session.mockImplementation(async () => { signIn("ben"); return session; });
    await expect(sendWorkCommand(command)).rejects.toThrow("account that recorded");
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("refuses a sign-out and same-owner sign-in during refresh", async () => {
    mocks.session.mockImplementation(async () => { signIn(null); signIn("anna"); return session; });
    await expect(sendWorkCommand(command)).rejects.toThrow("account that recorded");
    expect(mocks.boundRpc).not.toHaveBeenCalled();
  });
  it("refuses a session that does not match the app's current owner", async () => {
    mocks.session.mockResolvedValue({ data: { session: { access_token: "ben-token", user: { id: "ben" } } }, error: null });
    await expect(sendWorkCommand(command)).rejects.toThrow("account that recorded");
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("discards a late success and retries the same request as its original owner", async () => {
    mocks.boundRpc.mockImplementationOnce(async () => { signIn("ben"); return { data: "result", error: null }; });
    await expect(sendWorkCommand(command)).rejects.toThrow("account that recorded");
    signIn("anna");
    expect(await sendWorkCommand(command)).toBe("result");
    expect(mocks.boundRpc.mock.calls.map(([, args]) => args.p_id)).toEqual([command.id, command.id]);
    expect(mocks.client.mock.calls).toEqual([["anna-token"], ["anna-token"]]);
  });
  it("discards a response after an owner signs out and back in", async () => {
    mocks.boundRpc.mockImplementationOnce(async () => { signIn(null); signIn("anna"); return { data: "result", error: null }; });
    await expect(sendWorkCommand(command)).rejects.toThrow("account that recorded");
  });
  it("preserves a server refusal for the same owner", async () => {
    mocks.boundRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "Toolbox required" } });
    await expect(sendWorkCommand(command)).rejects.toMatchObject({ code: "P0001" });
  });
  it("preserves a refresh error without attempting a write", async () => {
    mocks.session.mockResolvedValue({ data: { session: null }, error: new Error("Refresh unavailable") });
    await expect(sendWorkCommand(command)).rejects.toThrow("Refresh unavailable");
    expect(mocks.client).not.toHaveBeenCalled();
  });
});
