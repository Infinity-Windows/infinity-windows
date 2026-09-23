// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
type Session = { user: { id: string } } | null;
const m = vi.hoisted(() => ({ get: vi.fn(), invalidate: vi.fn(), listeners: new Set<(event: string, session: Session) => void>() }));
vi.mock("./supabase", () => ({ supabase: { auth: {
  getSession: m.get,
  onAuthStateChange: (callback: (event: string, session: Session) => void) => {
    m.listeners.add(callback);
    return { data: { subscription: { unsubscribe: () => m.listeners.delete(callback) } } };
  },
} } }));
vi.mock("./queryClient", () => ({ queryClient: { invalidateQueries: m.invalidate } }));
import { useAskSessionActor } from "./useAskSessionActor";
function Probe() { const id = useAskSessionActor(); return <span>{id ?? "signed-out"}</span>; }
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  m.listeners.clear(); m.get.mockReset(); m.invalidate.mockReset(); m.invalidate.mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const emit = async (id: string | null) => { await act(async () => { for (const fn of m.listeners) fn("SIGNED_IN", id ? { user: { id } } : null); }); };
it("changes displayed actor on auth change and refreshes only the real profile", async () => {
  m.get.mockResolvedValue({ data: { session: { user: { id: "A" } } } });
  await act(async () => { root.render(<StrictMode><Probe /></StrictMode>); });
  expect(host.textContent).toBe("A"); await emit("B"); expect(host.textContent).toBe("B");
  expect(m.invalidate).toHaveBeenLastCalledWith({ queryKey: ["myRealProfile"], exact: true });
  await emit(null); expect(host.textContent).toBe("signed-out"); expect(m.listeners.size).toBe(1);
});
it("ignores an old boot session after a newer signed-in subject", async () => {
  let resolve!: (value: unknown) => void;
  m.get.mockReturnValue(new Promise(r => { resolve = r; }));
  await act(async () => { root.render(<StrictMode><Probe /></StrictMode>); });
  await emit("B"); await act(async () => { resolve({ data: { session: { user: { id: "A" } } } }); });
  expect(host.textContent).toBe("B");
});
it("does not refetch for token refresh of the same subject", async () => {
  m.get.mockResolvedValue({ data: { session: { user: { id: "A" } } } });
  await act(async () => { root.render(<Probe />); }); const before = m.invalidate.mock.calls.length;
  await emit("A"); expect(m.invalidate.mock.calls.length).toBe(before);
});
