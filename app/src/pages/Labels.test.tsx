// @vitest-environment happy-dom
//
// Slot labels: one page, two rules (ADR-0007).
//
// The route floor dropped to installer so the person at the rack can print a
// label. Retiring a slot and renaming one came along for the ride, and they
// are the destructive kind ADR-0007 kept at foreman+. `locations` is a plain
// table — its only policy is the partner wall, there is no RPC to refuse a
// rank, and `deleteLocations` is a real soft-delete that pulls a slot out of
// every picker on the site. So this page IS the wall, and a test that mounts
// it as an installer is the only thing that can notice if it stops being one.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { Location } from "../lib/types";
import { Labels } from "./Labels";

const slots: Location[] = [
  {
    id: "slot-1",
    zone: "S",
    rack: "03",
    slot: "B",
    address: "S-03-B",
    capacity: 4,
    active: true,
  },
  {
    id: "slot-2",
    zone: "S",
    rack: "03",
    slot: "C",
    address: "S-03-C",
    capacity: 4,
    active: true,
  },
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(role: "installer" | "foreman"): HTMLElement {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
  qc.setQueryData(["myRealProfile"], { id: "me", role });
  qc.setQueryData(["locations"], slots);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/labels"]}>
          <Labels />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return host;
}

function buttonSaying(el: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
}

/** Tick the first slot's checkbox, the way a thumb does. */
function selectFirstSlot(el: HTMLElement) {
  const box = el.querySelector<HTMLInputElement>('input[aria-label="Select S-03-B"]');
  if (!box) throw new Error("the slot's checkbox is not on the page");
  act(() => {
    box.click();
  });
}

describe("printing is everyone's (ADR-0007)", () => {
  it("gives an installer the print buttons", () => {
    const el = mount("installer");
    expect(buttonSaying(el, "Print 2 labels")).toBeTruthy();
    selectFirstSlot(el);
    expect(buttonSaying(el, "Print 1 selected")).toBeTruthy();
  });
});

describe("retiring and renaming a slot stay foreman+ (ADR-0007)", () => {
  it("keeps Delete selected away from an installer", () => {
    const el = mount("installer");
    selectFirstSlot(el);
    // The selection is live — the print button proves the row is ticked, so a
    // missing Delete is the rule and not an empty selection.
    expect(buttonSaying(el, "Print 1 selected")).toBeTruthy();
    expect(buttonSaying(el, "Delete 1 selected")).toBeFalsy();
  });

  it("keeps the address/name editor away from an installer", () => {
    const el = mount("installer");
    expect(buttonSaying(el, "Edit")).toBeFalsy();
  });

  it("gives a foreman both", () => {
    const el = mount("foreman");
    selectFirstSlot(el);
    expect(buttonSaying(el, "Delete 1 selected")).toBeTruthy();
    expect(buttonSaying(el, "Edit")).toBeTruthy();
  });
});
