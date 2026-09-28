// @vitest-environment happy-dom
//
// The Review AI drafts card (K2.8): what a supervisor reads for each AI
// draft, that Keep is a mark on this screen only, that Drop deletes only a
// row still in draft (and says so when it changed or was refused), and that
// Publish hands off to the page's one publish sheet rather than publishing
// anything itself.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleAssignment } from "../../lib/schedule/types";

const lang = vi.hoisted(() => ({ current: "en" as "en" | "es" }));
vi.mock("../../lib/i18n/context", () => ({
  useLanguage: () => ({ lang: lang.current, t: (k: string) => k, setLang: () => {}, needsChoice: false }),
}));

import { AiDraftReview, type AiDraftReviewProps } from "./AiDraftReview";

function draft(id: string, over: Partial<ScheduleAssignment> = {}): ScheduleAssignment {
  return {
    id, project_id: "p", kind: "install", delivery_id: null, start_date: "2026-09-28", end_date: "2026-09-28", start_time: null,
    status: "draft", color: null, note: null, created_by: null, created_via: "ai", published_at: null,
    created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:00:00Z",
    members: [{ profile_id: "ana", role: "installer", display_name: "Ana" }],
    project: { id: "p", job_code: "SMITH", name: "Smith Residence", address: null },
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const settle = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

async function mount(over: Partial<AiDraftReviewProps> = {}) {
  const props: AiDraftReviewProps = {
    drafts: [draft("a"), draft("b", { start_date: "2026-09-29", end_date: "2026-09-30", members: [{ profile_id: "ben", role: "installer", display_name: null }] })],
    outside: 0,
    reasons: new Map([["a", "Lead with wet glazing; keeps Team 1 together"]]),
    reasonsError: null,
    nameOf: (id) => (id === "ben" ? "Ben" : "Crew"),
    onDrop: vi.fn(async () => "dropped" as const),
    onPublish: vi.fn(),
    publishableCount: 3,
    formatError: (e) => `Could not remove it (${(e as Error).message}).`,
    ...over,
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<AiDraftReview {...props} />); });
  await settle();
  return props;
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; lang.current = "en"; });

const text = () => host!.textContent ?? "";
const buttons = (label: string) => [...host!.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label);
const rows = () => [...host!.querySelectorAll("li.sched-ai-review-row")];

describe("the Review AI drafts card", () => {
  it("lists each AI draft with its job, days, crew and the AI's reason — or says none was recorded", async () => {
    await mount();
    expect(text()).toContain("Review AI drafts");
    expect(text()).toContain("2 to review");
    expect(text()).toContain("SMITH");
    expect(text()).toMatch(/Sep 28 · Ana/);
    expect(text()).toMatch(/Sep 29 – Sep 30 · Ben/);
    expect(text()).toContain("Lead with wet glazing; keeps Team 1 together");
    expect(text()).toContain("No reason recorded");
    expect(text()).toContain("nothing reaches the crew until you publish");
  });

  it("says the reasons are still loading, and that the drafts stay when the reasons could not be read", async () => {
    await mount({ reasons: null });
    expect(text()).toContain("Reading the AI's reason…");
    act(() => root?.unmount());
    await mount({ reasons: new Map(), reasonsError: "JWT expired" });
    expect(host!.querySelector("[role=alert]")?.textContent).toContain("could not be loaded. The drafts are still here.");
    expect(rows()).toHaveLength(2);
  });

  it("Keep is a mark on this screen only: it toggles, and writes nothing", async () => {
    const props = await mount();
    await act(async () => buttons("Keep")[0].click());
    expect(rows()[0].getAttribute("data-kept")).toBe("true");
    expect(buttons("Kept")).toHaveLength(1);
    expect(buttons("Kept")[0].getAttribute("aria-pressed")).toBe("true");
    await act(async () => buttons("Kept")[0].click());
    expect(rows()[0].getAttribute("data-kept")).toBe("false");
    expect(props.onDrop).not.toHaveBeenCalled();
    expect(props.onPublish).not.toHaveBeenCalled();
  });

  it("Drop goes through the conditional delete; a refused drop says so in plain words and leaves the row", async () => {
    const onDrop = vi.fn(async (a: ScheduleAssignment) => { if (a.id === "b") throw new Error("row security"); return "dropped" as const; });
    await mount({ onDrop });
    await act(async () => buttons("Drop")[0].click());
    await settle();
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(host!.querySelector("[role=alert]")).toBeNull();
    await act(async () => buttons("Drop")[1].click());
    await settle();
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
    expect(host!.querySelector("[role=alert]")?.textContent).toBe("Could not remove it (row security). The draft is still here.");
    expect(rows()).toHaveLength(2);
  });

  it("a Drop that finds the draft changed — published by someone else meanwhile — claims no delete and says so", async () => {
    const onDrop = vi.fn(async () => "changed" as const);
    await mount({ onDrop });
    await act(async () => buttons("Keep")[0].click());
    await act(async () => buttons("Drop")[0].click());
    await settle();
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(host!.querySelector("[role=alert]")?.textContent).toBe("This draft changed since you opened it — it may have been published. Nothing was dropped; the list has been refreshed.");
    // Its Keep mark is cleared: the page re-reads and the row shows as it is now.
    expect(rows()[0].getAttribute("data-kept")).toBe("false");
    expect(buttons("Kept")).toHaveLength(0);
  });

  it("Review & publish hands off to the page's one publish sheet and says what that sheet sends", async () => {
    const props = await mount({ publishableCount: 5 });
    expect(text()).toContain("the AI drafts you kept and your own (5)");
    await act(async () => buttons("Review & publish")[0].click());
    expect(props.onPublish).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
    await mount({ publishableCount: 0, drafts: [], outside: 2 });
    expect(buttons("Review & publish")[0].disabled).toBe(true);
    expect(text()).toContain("No AI drafts in these dates.");
    expect(text()).toContain("2 more AI draft(s) outside these dates");
  });

  it("reads in Spanish", async () => {
    lang.current = "es";
    await mount({ outside: 1, onDrop: vi.fn(async () => "changed" as const) });
    expect(text()).toContain("Revisar borradores de la IA");
    expect(text()).toContain("2 por revisar");
    expect(text()).toContain("Sin motivo registrado");
    expect(buttons("Conservar")).toHaveLength(2);
    expect(buttons("Descartar")).toHaveLength(2);
    await act(async () => buttons("Descartar")[0].click());
    await settle();
    expect(host!.querySelector("[role=alert]")?.textContent).toMatch(/^Este borrador cambió desde que lo abriste/);
    expect(text()).toContain("1 borrador(es) más de la IA fuera de estas fechas");
    expect(buttons("Revisar y publicar")).toHaveLength(1);
  });
});
