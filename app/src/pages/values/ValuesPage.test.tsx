// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ tasks: vi.fn(), summary: vi.fn(), user: "owner-a", generation: 1, online: true,
  listeners: new Set<() => void>(), mounts: 0, unmounts: 0,
}));
vi.mock("../../lib/values/api", () => ({ fetchMyValuesTasks: m.tasks, fetchMyValuesSummary: m.summary }));
vi.mock("../../lib/signedIn", () => ({ signedInUserId: () => m.user, signInGeneration: () => m.generation,
  subscribeSignedIn: (cb: () => void) => { m.listeners.add(cb); return () => m.listeners.delete(cb); },
}));
vi.mock("../../lib/offline/useWeakSignal", () => ({ useConnection: () => ({ online: m.online, weak: false }) }));
vi.mock("../../components/values/ValueScoreForm", () => ({ ValueScoreForm: ({ ownerId }: { ownerId: string }) => {
  useEffect(() => { m.mounts++; return () => { m.unmounts++; }; }, []);
  return <div data-testid="active-form">Draft for {ownerId}</div>;
} }));
import { ValuesPage } from "./ValuesPage";

const task = { assignmentId: "assignment", subjectId: "subject", subjectName: "Review subject", periodStart: "2026-10-01",
  status: "pending", rubricVersion: 1, reason: "dealt", solo: false, submittedAt: null };
let root: Root; let host: HTMLDivElement; let qc: QueryClient;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  m.tasks.mockReset(); m.summary.mockReset(); m.listeners.clear(); m.user = "owner-a"; m.generation = 1; m.online = true; m.mounts = 0; m.unmounts = 0;
  m.tasks.mockResolvedValue([task]); m.summary.mockResolvedValue(null); onlineManager.setOnline(true);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); qc.clear(); host.remove(); onlineManager.setOnline(true); });
async function render() {
  await act(async () => root.render(<QueryClientProvider client={qc}><MemoryRouter><ValuesPage /></MemoryRouter></QueryClientProvider>));
}
async function open() {
  await render();
  await vi.waitFor(() => expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("Review subject"))).toBe(true));
  await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Review subject"))!.click());
  expect(host.textContent).toContain("Draft for owner-a");
}
it("preserves an active own draft through lost signal, paused refetch and fresh task responses", async () => {
  await open();
  m.online = false; onlineManager.setOnline(false);
  await render();
  void qc.invalidateQueries({ queryKey: ["valuesMyTasks"] });
  await render();
  expect(host.textContent).toContain("Draft for owner-a");
  expect(m.mounts).toBe(1); expect(m.unmounts).toBe(0);
  let finish!: (rows: typeof task[]) => void;
  m.tasks.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  m.online = true; onlineManager.setOnline(true);
  await render();
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(m.unmounts).toBe(0);
  await act(async () => finish([task]));
  expect(host.textContent).toContain("Draft for owner-a");
  expect(m.mounts).toBe(1); expect(m.unmounts).toBe(0);
});
it("closes the private draft on an A to B to A auth-generation boundary", async () => {
  await open();
  m.tasks.mockImplementation(() => new Promise(() => undefined));
  // Both identity transitions can happen before React renders; generation is
  // required even though the final user ID is again A.
  await act(async () => {
    m.user = "owner-b"; m.generation++; for (const cb of m.listeners) cb();
    m.user = "owner-a"; m.generation++; for (const cb of m.listeners) cb();
  });
  expect(host.querySelector('[data-testid="active-form"]')).toBeNull();
  expect(host.textContent).not.toContain("Review subject");
  expect(m.unmounts).toBe(1);
});
