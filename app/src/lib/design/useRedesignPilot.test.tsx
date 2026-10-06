// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signedInUserId, signInGeneration } from "../signedIn";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = "00000000-0000-4000-8000-000000000101";
const CREW = "00000000-0000-4000-8000-000000000102";
const rpc = vi.fn(async (_name: string): Promise<{ data: boolean | null; error: { message: string } | null }> => ({
  data: true, error: null,
}));
let role = "owner";
vi.mock("../supabase", () => ({ supabase: { rpc: (name: string) => rpc(name) } }));
vi.mock("../install/api", () => ({
  getRealProfile: async () => ({
    id: signedInUserId(), role, active: true, retired_at: null,
  }),
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
    await act(async () => { await qc!.invalidateQueries({ queryKey: ["myRealProfile"] }); });
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
    await act(async () => { await qc!.invalidateQueries({ queryKey: ["myRealProfile"] }); });
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
});
