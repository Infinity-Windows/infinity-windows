// @vitest-environment happy-dom
//
// The design switch in Settings (K-X2). Mounted for real with a seeded
// design context: the person's two buttons write their choice, and the
// owner-only release controls appear for an owner and nobody else.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignContext, type DesignContextValue } from "../../lib/design/context";

let realRole = "installer";
vi.mock("../../lib/useEffectiveRole", () => ({
  useEffectiveRole: () => ({
    realRole,
    effectiveRole: realRole,
    isPreviewing: false,
    isLoading: false,
    grants: {},
  }),
}));

const setNewDesignSwitch = vi.fn(async (_r: string, enabled: boolean) => ({
  id: 1,
  evening_nudge_local_time: "17:30:00",
  evening_nudge_enabled: true,
  new_design_r1_enabled: enabled,
  paid_time_from_start_day_on: null,
}));
const setPaidTimeRuleDate = vi.fn(async (on: string | null) => ({
  id: 1,
  evening_nudge_local_time: "17:30:00",
  evening_nudge_enabled: true,
  new_design_r1_enabled: true,
  paid_time_from_start_day_on: on,
}));
vi.mock("../../lib/companySettings", () => ({
  getCompanySettings: async () => ({
    id: 1,
    evening_nudge_local_time: "17:30:00",
    evening_nudge_enabled: true,
    new_design_r1_enabled: true,
    paid_time_from_start_day_on: null,
  }),
  setNewDesignSwitch: (...a: [string, boolean]) => setNewDesignSwitch(...a),
  setPaidTimeRuleDate: (...a: [string | null]) => setPaidTimeRuleDate(...a),
}));

const { DesignSettings } = await import("./DesignSettings");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setNewDesignSwitch.mockClear();
  setPaidTimeRuleDate.mockClear();
});

async function mount(ctx: Partial<DesignContextValue> = {}): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const value: DesignContextValue = {
    design: "classic",
    choice: "classic",
    masterOn: true,
    setChoice: vi.fn(),
    ...ctx,
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <DesignContext.Provider value={value}>
          <DesignSettings />
        </DesignContext.Provider>
      </QueryClientProvider>,
    );
  });
  // Let the settings query settle for the owner branch.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return host;
}

const buttonNamed = (el: HTMLElement, text: RegExp) =>
  [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => text.test(b.textContent ?? ""));

describe("DesignSettings", () => {
  it("lets a person switch to the new design and back, one tap each way", async () => {
    realRole = "installer";
    const setChoice = vi.fn();
    const el = await mount({ setChoice });
    expect(el.textContent).toContain("You're on the classic design.");
    act(() => buttonNamed(el, /Use the new design/)!.click());
    expect(setChoice).toHaveBeenCalledWith("new");
    act(() => buttonNamed(el, /Use the classic design/)!.click());
    expect(setChoice).toHaveBeenCalledWith("classic");
    // No owner controls for an installer.
    expect(el.textContent).not.toContain("master switch");
    expect(el.textContent).not.toContain("Paid time starts");
  });

  it("says out loud when the owner has the new design off, instead of a switch that does nothing", async () => {
    realRole = "foreman";
    const el = await mount({ choice: "new", design: "classic", masterOn: false });
    expect(el.textContent).toContain("turned the new design off for everyone");
  });

  it("gives the owner the master switch and the paid-time date, wired to the two RPCs", async () => {
    realRole = "owner";
    const el = await mount({ choice: "new", design: "new" });
    expect(el.textContent).toContain("New design master switch");
    expect(el.textContent).toContain("Paid time starts at Start day");
    expect(el.textContent).toContain("Off — today's timing applies.");
    await act(async () => buttonNamed(el, /Turn off for everyone/)!.click());
    expect(setNewDesignSwitch).toHaveBeenCalledWith("r1", false);

    const date = el.querySelector<HTMLInputElement>("#paid-time-from")!;
    const save = buttonNamed(el, /Save date/)!;
    expect(save.disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(date, "2099-01-05");
      date.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(setPaidTimeRuleDate).toHaveBeenCalledWith("2099-01-05");
  });
});
