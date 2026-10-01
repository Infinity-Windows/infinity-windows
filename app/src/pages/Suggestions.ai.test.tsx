// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ role: "owner", rows: [
  { id: "ai-1", author: "reporter", kind: "bug", body: "AI could not retrieve hours", status: "open", category: "ai", created_at: "2026-10-01T12:00:00Z", resolution_note: null as string | null },
  { id: "app-1", author: "reporter", kind: "idea", body: "Add a larger map", status: "open", category: "app", created_at: "2026-10-01T11:00:00Z", resolution_note: null as string | null },
], resolved: [] as { id: string; note: string | undefined }[] }));
vi.mock("../lib/useEffectiveRole", () => ({ useEffectiveRole: () => ({ effectiveRole: state.role }) }));
vi.mock("../lib/install/api", () => ({ listProfiles: async () => [{ id: "reporter", display_name: "Riley" }] }));
vi.mock("../lib/appFeedback", () => ({
  listAppFeedback: async () => state.rows.map((row) => ({ ...row })),
  submitAppFeedback: async () => undefined,
  resolveAppFeedback: async (id: string, note?: string) => {
    state.resolved.push({ id, note });
    const row = state.rows.find((item) => item.id === id)!;
    row.status = "resolved";
    row.resolution_note = note ?? null;
  },
}));
vi.mock("../components/voice/VoiceTextarea", () => ({ VoiceTextarea: () => null }));
import { Suggestions } from "./Suggestions";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const button = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name);
async function mount(role: string) {
  state.role = role;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Suggestions /></MemoryRouter></QueryClientProvider>));
  await settle();
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; state.resolved = []; state.rows[0].status = "open"; state.rows[0].resolution_note = null; });

describe("App Issues AI section", () => {
  it("lets an owner filter AI reports and requires a verification note to resolve", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await mount("owner");
    const filters = host!.querySelector('[aria-label="Section"]')!;
    await act(async () => [...filters.querySelectorAll("button")].find((item) => item.textContent === "AI")!.click());
    expect(host!.textContent).toContain("AI could not retrieve hours");
    expect(host!.textContent).not.toContain("Add a larger map");
    await act(async () => button("Resolve")!.click());
    const note = host!.querySelector<HTMLTextAreaElement>("textarea")!;
    const confirm = [...host!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Resolve" && item.disabled)!;
    expect(confirm.disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Verified hours report after fix");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const enabled = [...host!.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent === "Resolve" && !item.disabled).at(-1)!;
    await act(async () => enabled.click());
    await settle();
    expect(state.resolved).toEqual([{ id: "ai-1", note: "Verified hours report after fix" }]);
  });
  it("shows the reporter the current status and verification note", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.rows[0].status = "resolved";
    state.rows[0].resolution_note = "Verified on a phone";
    await mount("installer");
    await act(async () => button("Show resolved")!.click());
    expect(host!.textContent).toContain("AI could not retrieve hours");
    expect(host!.textContent).toContain("Verified on a phone");
    expect(host!.textContent).toContain("resolved");
    expect(host!.textContent).not.toContain("Resolve");
  });
});
