// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signedInUserId, signInGeneration } from "../signedIn";
import { OFFLINE_PILOT_PROOF_KEY } from "./offlinePilotProof";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = "00000000-0000-4000-8000-000000000101";
const CREW = "00000000-0000-4000-8000-000000000102";
const rpc = vi.fn(async (_name: string): Promise<{ data: boolean | null; error: { message: string; status?: number } | null }> => ({
  data: true, error: null,
}));
let role = "owner";
let choice = "new";
let loginId = "11111111-1111-4111-8111-111111111111";
let profileUnreachable = false;
const token = (id: string) => `header.${btoa(JSON.stringify({ sub: OWNER, session_id: id }))}.signature`;
vi.mock("../supabase", () => ({
  supabase: { rpc: (name: string) => rpc(name) },
  signInOnThisPhone: () => ({ user: { id: signedInUserId() }, access_token: token(loginId) }),
}));
vi.mock("../install/api", () => ({
  getRealProfile: async () => profileUnreachable ? null : ({
    id: signedInUserId(), role, ui_design: choice, active: true, retired_at: null,
  }),
  getRealProfileForPilot: async () => profileUnreachable
    ? { kind: "unreachable" }
    : { kind: "answered", profile: {
      id: signedInUserId(), role, ui_design: choice, active: true, retired_at: null,
    } },
}));
const { useRedesignPilot } = await import("./useRedesignPilot");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let qc: QueryClient | null = null;
let answer = false;

function Reader() {
  answer = useRedesignPilot();
  return <div data-testid="answer">{String(answer)}</div>;
}

async function mount(seed?: (client: QueryClient) => void) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(qc);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<QueryClientProvider client={qc!}><Reader /></QueryClientProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

beforeEach(() => {
  role = "owner";
  choice = "new";
  profileUnreachable = false;
  loginId = "11111111-1111-4111-8111-111111111111";
  localStorage.clear();
  rpc.mockReset();
  rpc.mockResolvedValue({ data: true, error: null });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  onlineManager.setOnline(true);
  window.dispatchEvent(new Event("online"));
  rememberSignedIn({ user: { id: OWNER } });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  qc?.clear();
  root = null; host = null; qc = null;
  rememberSignedIn(null);
  onlineManager.setOnline(true);
});

describe("owner redesign pilot admission", () => {
  it("waits for the server and admits only the real owner", async () => {
    await mount();
    expect(answer).toBe(true);
    expect(rpc).toHaveBeenCalledWith("my_redesign_pilot_access");
    role = "installer";
    await act(async () => { await qc!.invalidateQueries({ queryKey: ["redesignPilotProfile"] }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(answer).toBe(false);
  });

  it("fails closed when the server refuses or the account changes", async () => {
    await mount();
    expect(answer).toBe(true);
    role = "installer";
    rpc.mockResolvedValue({ data: false, error: null });
    await act(async () => rememberSignedIn({ user: { id: CREW } }));
    expect(answer).toBe(false);
    await act(async () => { await qc!.invalidateQueries({ queryKey: ["redesignPilotProfile"] }); });
    expect(answer).toBe(false);
  });

  it("keeps a short in-memory owner lease through a signal blip, but never across accounts", async () => {
    await mount();
    expect(answer).toBe(true);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await act(async () => window.dispatchEvent(new Event("offline")));
    expect(answer).toBe(true);
    await act(async () => rememberSignedIn({ user: { id: CREW } }));
    expect(answer).toBe(false);
  });

  it("honors a fresh server revocation immediately, even within the lease", async () => {
    await mount();
    expect(answer).toBe(true);
    rpc.mockResolvedValue({ data: false, error: null });
    await act(async () => { await qc!.invalidateQueries({ queryKey: ["redesignPilot"] }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(answer).toBe(false);
    expect(localStorage.getItem(OFFLINE_PILOT_PROOF_KEY)).toBeNull();
  });

  it("does not admit on a missing or failing server function", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "missing function" } });
    await mount();
    expect(answer).toBe(false);
  });

  it("does not trust an old positive query-cache result before its own server read", async () => {
    let finish: ((value: { data: boolean | null; error: null }) => void) | null = null;
    rpc.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount((client) => {
      client.setQueryData(["myRealProfile"], { id: OWNER, role: "owner", active: true, retired_at: null });
      client.setQueryData(["redesignPilot", OWNER, signInGeneration()], true);
    });
    expect(answer).toBe(false);
    await act(async () => finish?.({ data: false, error: null }));
    expect(answer).toBe(false);
  });

  it("keeps New after an offline full remount for the same owner login", async () => {
    await mount();
    expect(answer).toBe(true);
    expect(localStorage.getItem(OFFLINE_PILOT_PROOF_KEY)).toContain(OWNER);
    act(() => root?.unmount());
    qc?.clear(); host?.remove(); root = null; qc = null; host = null;
    profileUnreachable = true;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    onlineManager.setOnline(false);
    await act(async () => window.dispatchEvent(new Event("offline")));
    await mount();
    expect(answer).toBe(true);
  });

  it("keeps New when the phone claims online but both server reads cannot connect", async () => {
    await mount();
    expect(answer).toBe(true);
    act(() => root?.unmount());
    qc?.clear(); host?.remove(); root = null; qc = null; host = null;
    profileUnreachable = true;
    rpc.mockResolvedValue({ data: null, error: { message: "Failed to fetch" } });
    await mount();
    expect(answer).toBe(true);
  });

  it("lets a server refusal beat an older offline proof even when its wording resembles a fetch failure", async () => {
    await mount();
    expect(answer).toBe(true);
    act(() => root?.unmount());
    qc?.clear(); host?.remove(); root = null; qc = null; host = null;
    rpc.mockResolvedValue({ data: null, error: { status: 403, message: "Failed to fetch" } });
    await mount();
    expect(answer).toBe(false);
    expect(localStorage.getItem(OFFLINE_PILOT_PROOF_KEY)).toBeNull();
  });

  it("does not use a stored yes before an online server attempt finishes", async () => {
    await mount();
    expect(answer).toBe(true);
    act(() => root?.unmount());
    qc?.clear(); host?.remove(); root = null; qc = null; host = null;
    let finish: ((value: { data: boolean | null; error: { message: string } | null }) => void) | null = null;
    rpc.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    expect(answer).toBe(false);
    await act(async () => finish?.({ data: false, error: null }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(answer).toBe(false);
    expect(localStorage.getItem(OFFLINE_PILOT_PROOF_KEY)).toBeNull();
  });

  it("does not reuse an offline proof after the same owner signs in again", async () => {
    await mount();
    expect(answer).toBe(true);
    act(() => root?.unmount());
    qc?.clear(); host?.remove(); root = null; qc = null; host = null;
    rememberSignedIn(null);
    loginId = "22222222-2222-4222-8222-222222222222";
    rememberSignedIn({ user: { id: OWNER } });
    profileUnreachable = true;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    onlineManager.setOnline(false);
    await mount();
    expect(answer).toBe(false);
  });

  it("erases the offline proof on sign-out", async () => {
    await mount();
    expect(localStorage.getItem(OFFLINE_PILOT_PROOF_KEY)).not.toBeNull();
    await act(async () => rememberSignedIn(null));
    expect(answer).toBe(false);
    expect(localStorage.getItem(OFFLINE_PILOT_PROOF_KEY)).toBeNull();
  });

  it("removes an admitted owner's offline proof when they choose Classic", async () => {
    await mount();
    expect(answer).toBe(true);
    choice = "classic";
    await act(async () => { await qc!.invalidateQueries({ queryKey: ["redesignPilotProfile"] }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(answer).toBe(true); // The grant remains; the owner can switch back.
    expect(localStorage.getItem(OFFLINE_PILOT_PROOF_KEY)).toBeNull();
  });
});
