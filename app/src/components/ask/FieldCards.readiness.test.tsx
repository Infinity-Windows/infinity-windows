// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldReceipt, PhoneTimingState } from "../../lib/fieldAsk";
import { WORK_QUEUE_EVENT } from "../../lib/customWork/queue";

const signals = vi.hoisted(() => ({
  changed: new Set<() => void>(),
  synced: new Set<() => void>(),
}));
vi.mock("../../lib/offline/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/offline/outbox")>();
  return {
    ...actual,
    subscribe: (cb: () => void) => { signals.changed.add(cb); return () => signals.changed.delete(cb); },
    subscribeSynced: (cb: () => void) => { signals.synced.add(cb); return () => signals.synced.delete(cb); },
  };
});

import { FieldReceiptCard } from "./FieldCards";

const receipt: FieldReceipt = {
  action_id: "start-1", action: "start_unit", status: "needs_choice", reason: "wrong_job",
  project_id: "11111111-1111-4111-8111-111111111111",
  options: [{ id: "start_now", label: "Start now" }, { id: "cancel", label: "Cancel" }],
};
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  signals.changed.clear();
  signals.synced.clear();
});

function render(actorId: string, timingState: (actor: string) => Promise<PhoneTimingState>, hidden = false, card = receipt) {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root!.render(<div hidden={hidden}><FieldReceiptCard receipt={card} actorId={actorId} onChange={() => undefined} timingState={timingState} /></div>));
  return host;
}
async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
function startButton() {
  const button = [...host!.querySelectorAll<HTMLButtonElement>(".field-options button")].find((b) => b.textContent === "Start now");
  if (!button) throw new Error("missing Start now button");
  return button;
}

describe("Ask timing readiness", () => {
  it("waits through a queued switch, then enables the separate tap after sync even while Ask was hidden", async () => {
    let status: PhoneTimingState = "pending";
    const read = vi.fn(async () => status);
    const el = render("worker-a", read);
    await settle();
    expect(startButton().disabled).toBe(true);
    expect(el.textContent).toContain("Waiting for this phone's clock or timer changes to sync");
    expect(signals.changed.size).toBe(1);
    render("worker-a", read, true);
    status = "clear";
    await act(async () => { for (const cb of signals.synced) cb(); });
    await settle();
    render("worker-a", read);
    expect(startButton().disabled).toBe(false);
    expect(el.textContent).not.toContain("Waiting for this phone's clock or timer changes to sync");
  });

  it("keeps timing blocked until mixed clock and unit work are all clear, while Cancel remains available", async () => {
    let status: PhoneTimingState = "pending";
    const read = vi.fn(async () => status);
    render("worker-a", read);
    await settle();
    expect(startButton().disabled).toBe(true);
    const cancel = [...host!.querySelectorAll<HTMLButtonElement>(".field-options button")].find((b) => b.textContent === "Cancel");
    expect(cancel?.disabled).toBe(false);
    window.dispatchEvent(new Event(WORK_QUEUE_EVENT));
    await settle();
    expect(startButton().disabled).toBe(true);
    status = "clear";
    await act(async () => { for (const cb of signals.changed) cb(); });
    await settle();
    expect(startButton().disabled).toBe(false);
  });

  it("describes a paused end-break action without calling it Start now", async () => {
    const card: FieldReceipt = { ...receipt, reason: "on_break", options: [{ id: "end_break_and_start", label: "End break and start" }, { id: "cancel", label: "Cancel" }] };
    render("worker-a", async () => "pending", false, card);
    await settle();
    expect(host!.textContent).toContain("This timing action is paused");
    expect(host!.textContent).not.toContain("Start now is paused");
    const endBreak = [...host!.querySelectorAll<HTMLButtonElement>(".field-options button")].find((b) => b.textContent === "End break and start");
    expect(endBreak?.disabled).toBe(true);
  });

  it("never uses the previous account's late clear result for the new account", async () => {
    let releaseOld: ((state: PhoneTimingState) => void) | null = null;
    const read = vi.fn((actor: string) => actor === "worker-a"
      ? new Promise<PhoneTimingState>((resolve) => { releaseOld = resolve; })
      : Promise.resolve<PhoneTimingState>("pending"));
    render("worker-a", read);
    render("worker-b", read);
    await settle();
    expect(startButton().disabled).toBe(true);
    await act(async () => releaseOld?.("clear"));
    await settle();
    expect(startButton().disabled).toBe(true);
    expect(host!.textContent).toContain("Waiting for this phone's clock or timer changes to sync");
  });

  it("lets the worker recheck an unreadable phone queue", async () => {
    let status: PhoneTimingState = "unreadable";
    const read = vi.fn(async () => status);
    render("worker-a", read);
    await settle();
    expect(startButton().disabled).toBe(true);
    expect(host!.textContent).toContain("could not be checked");
    status = "clear";
    const retry = [...host!.querySelectorAll<HTMLButtonElement>(".field-timing-wait button")][0];
    await act(async () => retry.click());
    await settle();
    expect(startButton().disabled).toBe(false);
  });

  it("rechecks a newly queued clock change at the tap even if the card looked clear", async () => {
    let status: PhoneTimingState = "clear";
    const read = vi.fn(async () => status);
    render("worker-a", read);
    await settle();
    expect(startButton().disabled).toBe(false);
    status = "pending"; // The queue changed before its UI event reached Ask.
    await act(async () => startButton().click());
    await settle();
    expect(startButton().disabled).toBe(true);
    expect(host!.textContent).toContain("Nothing was started");
  });
});
