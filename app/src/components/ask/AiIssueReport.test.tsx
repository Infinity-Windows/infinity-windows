// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const submit = vi.hoisted(() => vi.fn<(kind: "bug" | "idea", body: string, options: { category: string; actorId: string }) => Promise<void>>());
vi.mock("../../lib/appFeedback", () => ({ submitAppFeedback: submit }));
import { AiIssueReport } from "./AiIssueReport";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const button = (text: string) => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

async function mount(channel: "text" | "live" = "text") {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>
    <AiIssueReport actorId="speaker-1" channel={channel} question="Show my job hours" answer="I could not retrieve them" />
  </MemoryRouter></QueryClientProvider>));
}

afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; submit.mockReset(); });

describe("AI issue report", () => {
  it("requires an editable preview and explicit send, then cannot file twice", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    submit.mockResolvedValue(undefined);
    await mount();
    expect(submit).not.toHaveBeenCalled();
    await act(async () => button("Report an AI issue")!.click());
    const field = host!.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(field.value).toContain("Show my job hours");
    expect(field.value).toContain("I could not retrieve them");
    expect(field.maxLength).toBe(2000);
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "The AI missed my job hours");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send to App Issues")!.click());
    await settle();
    expect(submit).toHaveBeenCalledWith("bug", "The AI missed my job hours", { category: "ai", actorId: "speaker-1" });
    expect(host!.textContent).toContain("Sent to App Issues → AI.");
    expect(button("Send to App Issues")).toBeUndefined();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("leaves a failed live report editable for retry", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    submit.mockRejectedValueOnce(new Error("Network unavailable")).mockResolvedValueOnce(undefined);
    await mount("live");
    await act(async () => button("Report an AI issue")!.click());
    expect(host!.querySelector("textarea")?.textContent).toContain("AI issue — Live Chat");
    await act(async () => button("Send to App Issues")!.click());
    await settle();
    expect(host!.querySelector("[role=alert]")?.textContent).toContain("Network unavailable");
    expect(host!.querySelector("textarea")).not.toBeNull();
    await act(async () => button("Send to App Issues")!.click());
    await settle();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(host!.textContent).toContain("Sent to App Issues → AI.");
  });
});
