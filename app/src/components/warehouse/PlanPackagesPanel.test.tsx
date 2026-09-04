// @vitest-environment happy-dom
//
// Minting is the whole crew's; burning is not (ADR-0007).
//
// The installer day map says out loud "Mint a window's labels before the
// truck", and mint_mark_packages is one of the eighteen functions ADR-0007
// opened. This panel is that function's ONLY door in the app, so if it goes
// back to foreman+ the map starts lying to the person reading it. Burn is the
// opposite case: burn_packages still refuses below foreman on the server, so
// the button has to be absent rather than present-and-refused.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { StoragePackage } from "../../lib/storage";
import { PlanPackagesPanel } from "./PlanPackagesPanel";

const PROJECT = "job-1";

const minted: StoragePackage = {
  id: "pkg-1",
  serial: "PKG-000001",
  short_code: null,
  status: "minted",
  project_id: PROJECT,
  category: null,
  note: null,
  delivery_id: null,
  container_id: null,
  location_id: null,
  bound_at: null,
  bound_by: null,
  created_at: "2026-09-04T00:00:00Z",
  package_marks: [{ mark_code: "16" }],
  part_index: 1,
  part_total: 4,
};

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
  qc.setQueryData(["scheduledMarks", [PROJECT]], [
    { project_id: PROJECT, mark_code: "16" },
  ]);
  qc.setQueryData(["storagePackages"], [minted]);
  qc.setQueryData(["markSpecs", PROJECT], []);
  qc.setQueryData(["studioUnits"], []);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/projects/${PROJECT}?tab=warehouse`]}>
          <PlanPackagesPanel projectId={PROJECT} jobCode="BLACK22" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return host;
}

function buttonSaying(el: HTMLElement, text: string) {
  return [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
}

describe("the plan-packages panel (ADR-0007)", () => {
  it("lets an installer mint a window's labels", () => {
    const el = mount("installer");
    expect(el.textContent).toContain("Window 16");
    expect(buttonSaying(el, "Mint")).toBeTruthy();
  });

  it("still lets an installer print what is already minted", () => {
    const el = mount("installer");
    expect(buttonSaying(el, "Print all on-the-way labels")).toBeTruthy();
  });

  it("keeps burning to a foreman, because the server does", () => {
    expect(buttonSaying(mount("installer"), "Burn labels")).toBeFalsy();
    expect(buttonSaying(mount("foreman"), "Burn labels")).toBeTruthy();
  });
});
