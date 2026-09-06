// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../lib/types";
import type { StorageContainer, StoragePackage } from "../../lib/storage";
import { SendToSite, SENT_TO_SITE_REASON } from "./SendToSite";

// The three writes this screen makes, caught so the test reads what was sent.
const sent: { ids: string[]; reason: string; project: string }[] = [];
const rpc: string[] = [];
vi.mock("../../lib/warehouse/offlineWrites", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/warehouse/offlineWrites")>()),
  checkoutPackagesOffline: async (ids: string[], reason: string, project: string) => {
    sent.push({ ids, reason, project });
    return { count: ids.length, queued: false };
  },
}));
vi.mock("../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/storage")>()),
  finalizeJobMaterials: async () => {
    rpc.push("finalize");
  },
  reopenJobMaterials: async () => {
    rpc.push("reopen");
  },
  boneyardJobLeftovers: async () => {
    rpc.push("boneyard");
    return 2;
  },
}));

const JOB: Project = {
  id: "job-1", job_code: "ESH-18", name: "Eshelman", address: null, status: "active",
} as Project;
const CONEX: StorageContainer = {
  id: "c7", serial: "CTR-000007", name: "Conex 7", address: null, access_code: null, notes: null,
  active: true, created_at: "2026-08-01T00:00:00Z", kind: "conex",
};
const pkg = (id: string, over: Partial<StoragePackage> = {}): StoragePackage => ({
  id, serial: `PKG-${id}`, short_code: null, status: "stored", project_id: "job-1", category: null, note: null,
  delivery_id: null, container_id: "c7", bound_at: "2026-09-01T00:00:00Z", bound_by: null,
  created_at: "2026-08-10T00:00:00Z", package_marks: [], ...over,
});

let host: HTMLElement | null = null;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  sent.length = 0;
  rpc.length = 0;
});

function mount(seed: { packages: StoragePackage[]; role?: "installer" | "foreman"; job?: Project }): HTMLElement {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity, refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false } },
  });
  qc.setQueryData(["myRealProfile"], { id: "me", role: seed.role ?? "foreman" });
  qc.setQueryData(["projectsAll"], [seed.job ?? JOB]);
  qc.setQueryData(["projects"], [seed.job ?? JOB]);
  qc.setQueryData(["storagePackages"], seed.packages);
  qc.setQueryData(["storageContainers"], [CONEX]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/warehouse/send/job-1"]}>
          <Routes>
            <Route path="/warehouse/send/:projectId" element={<SendToSite />} />
            <Route path="/warehouse/history" element={<p>history page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return host;
}
const click = (n: Element | null | undefined) => act(() => n?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe("sending a whole job to the job site", () => {
  const here = [
    pkg("a", { package_marks: [{ mark_code: "16" }] }),
    pkg("b", { package_marks: [{ mark_code: "16" }] }),
    pkg("c", { package_marks: [{ mark_code: "2" }], status: "received", container_id: null }),
    pkg("d", { package_marks: [{ mark_code: "9" }], status: "checked_out", container_id: null }),
  ];
  it("lists every unit here, ticked to go, and moves them through check-out with the site reason", async () => {
    const el = mount({ packages: here });
    const boxes = [...el.querySelectorAll<HTMLInputElement>(".send-unit input")];
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
    expect(el.textContent).toContain("Move 2 units (3 pieces) to the job site");
    click(button(el, "Move to job site"));
    await settle();
    expect(sent).toEqual([{ ids: ["c", "a", "b"], reason: SENT_TO_SITE_REASON, project: "job-1" }]);
  });
  it("keeps back the units a person unticks", async () => {
    const el = mount({ packages: here });
    const w16 = [...el.querySelectorAll<HTMLInputElement>(".send-unit input")].find((b) => b.getAttribute("aria-label")?.startsWith("Window 16"));
    click(w16);
    expect(el.textContent).toContain("Move 1 unit (1 piece) to the job site · 1 stays");
    click(button(el, "Move to job site"));
    await settle();
    expect(sent[0].ids).toEqual(["c"]);
  });
  it("will not finalize while anything is still in a box, and offers the Boneyard", async () => {
    const el = mount({ packages: here });
    const fin = button(el, "Unit Movement Finalized")!;
    expect(fin.disabled).toBe(true);
    expect(fin.title).toContain("3 packages are still in the warehouse (Conex 7 ×2, not in a box yet ×1)");
    click(button(el, "Move leftovers to the Boneyard"));
    await settle();
    expect(rpc).toEqual(["boneyard"]);
  });
  it("finalizes once the job is out, foreman and up only", async () => {
    const out = [pkg("d", { package_marks: [{ mark_code: "9" }], status: "checked_out", container_id: null })];
    const inst = mount({ packages: out, role: "installer" });
    expect(button(inst, "Unit Movement Finalized")!.disabled).toBe(true);
    expect(inst.textContent).toContain("A foreman or above finalizes");
    act(() => root?.unmount());
    const el = mount({ packages: out });
    expect(el.textContent).toContain("Nothing of ESH-18 is left in the warehouse.");
    const fin = button(el, "Unit Movement Finalized")!;
    expect(fin.disabled).toBe(false);
    click(fin);
    await settle();
    expect(rpc).toEqual(["finalize"]);
    expect(el.textContent).toContain("history page");
  });
  it("shows a finalized job's stamp and lets a foreman reopen it", async () => {
    const el = mount({ packages: [], job: { ...JOB, materials_finalized_at: "2026-09-06T18:00:00Z" } });
    expect(el.textContent).toContain("Unit movement finalized on 2026-09-06");
    click(button(el, "Reopen in the warehouse"));
    await settle();
    expect(rpc).toEqual(["reopen"]);
  });
});
