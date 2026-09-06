// @vitest-environment happy-dom
//
// The warehouse page, driven the way a person drives it.
//
// This exists because of a specific way this code shipped broken. The
// "staged for BLACK22" label was written, exported and unit-tested, and every
// test that covered it built its locations map by hand — so the tests passed
// on a path the app never took. No screen loaded locations at all, and every
// staged package everywhere read "on a shelf". A fixture stood in for a value
// production never supplied.
//
// So this test does not call findInWarehouse. It mounts the real page, seeds
// only the rows the server would have returned, types into the real Find box,
// and reads the answer off the real DOM. If the page stops loading locations,
// or stops handing them to Find, the seeded rows go unread and this fails.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Location } from "../lib/types";
import type { StorageContainer, StoragePackage } from "../lib/storage";
import { Warehouse } from "./Warehouse";

// The page warms the offline cache on mount. That is a background errand
// against the real server and has nothing to do with what is being checked
// here, so it is held still — everything else on the page is the real thing.
vi.mock("../lib/queryClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/queryClient")>()),
  prefetchWarehousePack: async () => {},
}));

const bay: Location = {
  id: "bay-1",
  zone: "J",
  rack: "BLACK22",
  slot: "A",
  address: "J-BLACK22-A",
  capacity: 4,
  active: true,
};

const conex: StorageContainer = {
  id: "conex",
  serial: "CTR-000001",
  name: "Conex 3",
  address: null,
  access_code: null,
  notes: null,
  active: true,
  created_at: "2026-08-17T00:00:00Z",
  parent_container_id: null,
  location_id: null,
};

let seq = 0;
function packageRow(
  over: Partial<StoragePackage> & { marks?: string[] } = {},
): StoragePackage {
  const { marks, ...rest } = over;
  seq += 1;
  return {
    id: `pkg-${seq}`,
    serial: `PKG-${String(seq).padStart(6, "0")}`,
    short_code: null,
    status: "stored",
    project_id: "job-1",
    category: null,
    note: null,
    delivery_id: null,
    container_id: "conex",
    location_id: null,
    bound_at: null,
    bound_by: null,
    created_at: "2026-08-17T00:00:00Z",
    package_marks: (marks ?? []).map((mark_code) => ({ mark_code })),
    ...rest,
  };
}

const JOBS = [
  { id: "job-1", job_code: "BLACK22", name: "Black Desert" },
  { id: "job-2", job_code: "SUNVALE14", name: "Sun Valley" },
];

interface Seed {
  packages: StoragePackage[];
  /** Empty in one test on purpose: a page holding no locations, which is
   * exactly the state the app shipped in. */
  locations: Location[];
  /** Defaults to foreman, which renders the whole page. Set "installer" to see
   * only what somebody at the truck sees. */
  role?: "installer" | "foreman";
  /** Defaults to the one conex. */
  containers?: StorageContainer[];
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Mount the real page and return its live DOM node. */
function mount(seed: Seed): HTMLElement {
  // Seeded rows count as fresh, so nothing goes back to the server behind the
  // test's back. What is seeded below is the whole world this page can see.
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
  // A foreman by default: the Find bar is on the page for every role, but
  // seeding a lead renders the whole page, so nothing is hidden by a role gate.
  qc.setQueryData(["myRealProfile"], { id: "me", role: seed.role ?? "foreman" });
  qc.setQueryData(["projects"], JOBS);
  // The name map reads every job whatever its status (job lifecycle,
  // 2026-08-26) — same fixture list here, no finished jobs in these tests.
  qc.setQueryData(["projectsAll"], JOBS);
  qc.setQueryData(["storagePackages"], seed.packages);
  qc.setQueryData(["storageContainers"], seed.containers ?? [conex]);
  qc.setQueryData(["issues"], []);
  qc.setQueryData(["supplies"], []);
  qc.setQueryData(["scheduledMarks", JOBS.map((j) => j.id)], []);
  qc.setQueryData(["locations"], seed.locations);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/warehouse"]}>
          <Warehouse />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return host;
}

/** Type into the real Find box, the way a thumb does. */
function typeFind(el: HTMLElement, text: string) {
  const input = el.querySelector<HTMLInputElement>(
    'input[aria-label="Find anything in the warehouse"]',
  );
  if (!input) throw new Error("the Find box is not on the page");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(node: Element | null | undefined) {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Find on the real warehouse page", () => {
  it("names the job a staged package is set aside for", () => {
    // The package sits on a job's staging bay: no container, a bay for a slot.
    const p = packageRow({ container_id: null, location_id: "bay-1" });
    const el = mount({ packages: [p], locations: [bay] });
    typeFind(el, p.serial);
    expect(el.textContent).toContain("staged for BLACK22 — J-BLACK22-A");
  });

  it("reads that off the locations query, not off anything lying around", () => {
    // Identical to the test above except the locations query returned nothing.
    // This is the exact state the app shipped in, and the page has nothing
    // honest to say beyond "a shelf".
    const p = packageRow({ container_id: null, location_id: "bay-1" });
    const el = mount({ packages: [p], locations: [] });
    typeFind(el, p.serial);
    expect(el.textContent).not.toContain("staged for BLACK22");
    expect(el.textContent).toContain("on a shelf");
  });

  it("asks which job when two of them have a window by that number", () => {
    // Window numbers come off the plans, so both live jobs have a 16. The page
    // used to answer with whichever came first — confident, and wrong half the
    // time.
    const el = mount({
      packages: [
        packageRow({ project_id: "job-1", marks: ["16"] }),
        packageRow({ project_id: "job-2", marks: ["16"] }),
      ],
      locations: [bay],
    });
    typeFind(el, "16");
    expect(el.textContent).toContain("more than one job has one");
    expect(el.textContent).toContain("BLACK22");
    expect(el.textContent).toContain("SUNVALE14");
  });

  it("picking a job off that list answers for that job", () => {
    const el = mount({
      packages: [
        packageRow({ project_id: "job-1", marks: ["16"] }),
        packageRow({ project_id: "job-2", marks: ["16"] }),
      ],
      locations: [bay],
    });
    typeFind(el, "16");
    const pick = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("SUNVALE14"),
    );
    click(pick);
    expect(el.textContent).toContain("Window 16 · SUNVALE14");
    expect(el.textContent).not.toContain("more than one job has one");
  });

  it("one job with that window still answers with no extra tap", () => {
    const el = mount({
      packages: [packageRow({ project_id: "job-1", marks: ["16"] })],
      locations: [bay],
    });
    typeFind(el, "16");
    expect(el.textContent).not.toContain("more than one job has one");
    expect(el.textContent).toContain("Window 16 · BLACK22");
  });
});

describe("the doors that used to hide in Other tools (wave 3)", () => {
  // The fold is gone: slot labels are a chip under the yard, and scanning is
  // the floating Scan button the layout draws on every warehouse screen.
  it("never dead-ends on a retired door", () => {
    // Slot labels went with the slot model (wave 5): a job's bay is a box now.
    const el = mount({ packages: [], locations: [bay] });
    const hrefs = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).not.toContain("/labels");
    expect(hrefs).not.toContain("/warehouse/on-hand");
    expect(hrefs).not.toContain("/count");
  });
});

describe("what an installer can still reach", () => {
  // D6 locked the Storage hub to foreman+, which was right, and in doing so it
  // shut BOTH doors to tagging: the hub's Tag button, and the warehouse page's
  // "Coming in" section, which was lead-only. /storage/tag stayed
  // installer-level in the registry and the role tests kept passing, because a
  // registry says who MAY open a route and says nothing about whether anything
  // on screen takes them there.
  //
  // The rule this protects is S3: whoever is at the truck tags. An installer
  // is usually who that is. Ticket 20 retired the standalone Tag button in
  // favor of ONE front door — Log a delivery, whose own first choice ("with
  // QR stickers") goes straight to /storage/tag — so the door installers need
  // moved, but it did not close.
  it("puts a delivery-logging link in front of an installer", () => {
    const el = mount({ packages: [], locations: [], role: "installer" });
    const logDelivery = [...el.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === "/storage/log-delivery",
    );
    expect(
      logDelivery,
      "an installer has no way to log a delivery, so no way to tag",
    ).toBeTruthy();
    expect(logDelivery!.textContent).toContain("Log a delivery");
  });

  it("does not dangle the foreman-only doors in front of them", () => {
    const el = mount({ packages: [], locations: [], role: "installer" });
    const hrefs = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).not.toContain("/receive");
    expect(hrefs).not.toContain("/storage");
  });

  it("still gives a foreman the delivery-logging door", () => {
    // "/receive" left this list when the unit chain retired (ticket 21):
    // receiving IS tagging now, and the old address is a thin door elsewhere.
    // "/storage" retired with the hub merge (ticket 18) — its tools live
    // right here now, not behind a separate link.
    const el = mount({ packages: [], locations: [], role: "foreman" });
    const hrefs = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/storage/log-delivery");
    expect(hrefs).not.toContain("/receive");
    expect(hrefs).not.toContain("/storage");
  });
});

describe("container tools absorbed from the Storage hub (ticket 18)", () => {
  // These three were foreman-only until ADR-0007 (owner call, 2026-09-04):
  // warehouse actions are crew actions. Registering the conex that turned up,
  // printing its door poster and running off a roll of blank stickers are all
  // things the person at the truck does, so the assertion is inverted on
  // purpose — an installer is now expected to see all three.
  it("gives an installer New container / Print blank stickers / All posters", () => {
    const el = mount({ packages: [], locations: [], role: "installer" });
    for (const label of ["New container", "Print blank stickers", "All posters"]) {
      const hit = [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes(label),
      );
      expect(hit, `an installer should see "${label}"`).toBeTruthy();
    }
  });

  it("gives a foreman all three, in the sections they now belong to", () => {
    const el = mount({ packages: [], locations: [], role: "foreman" });
    for (const label of ["New container", "Print blank stickers", "All posters"]) {
      const hit = [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes(label),
      );
      expect(hit, `a foreman should see "${label}"`).toBeTruthy();
    }
  });

  it("names each job holding stock in a container tile, not just a count", () => {
    // The Storage hub's job breakdown ("BLACK22 ×1") — the one thing its own
    // container tiles said that this page's didn't, before the merge.
    const p = packageRow({ status: "stored", container_id: "conex", project_id: "job-1" });
    const el = mount({ packages: [p], locations: [], role: "foreman" });
    expect(el.textContent).toContain("1 package · BLACK22 ×1");
  });
});

describe("the yard (wave 3)", () => {
  it("draws every box as a box, the building first", () => {
    const main: StorageContainer = { ...conex, id: "main", serial: "CTR-000009", name: "Main warehouse", kind: "building" };
    const el = mount({ packages: [], locations: [], role: "installer", containers: [conex, main] });
    const names = [...el.querySelectorAll('[data-testid="yard-box"] .yard-name')].map((n) => n.textContent);
    expect(names).toEqual(["Main warehouse", "Conex 3"]);
  });
  it("lights up the box Find's answer sits in", () => {
    const p = packageRow({ status: "stored", container_id: "conex", marks: ["16"] });
    const el = mount({ packages: [p], locations: [], role: "installer" });
    expect(el.querySelector(".yard-box--glow")).toBeNull();
    typeFind(el, "16");
    expect(el.querySelector(".yard-box--glow")?.textContent).toContain("Conex 3");
  });
  it("lists 'Deliveries — check trucks in' exactly once — the old duplicate is gone", () => {
    const el = mount({ packages: [], locations: [], role: "foreman" });
    const hits = [...el.querySelectorAll("a")].filter(
      (a) => a.textContent?.trim() === "Deliveries — check trucks in",
    );
    expect(hits).toHaveLength(1);
  });

  it("keeps station 1's buttons open to an installer, same as before the redesign", () => {
    const el = mount({ packages: [], locations: [], role: "installer" });
    const hrefs = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/storage/deliveries");
    expect(hrefs).toContain("/storage/log-delivery");
    expect(hrefs).toContain("/storage/tag");
    expect(hrefs).toContain("/storage/arrive");
    expect(hrefs).toContain("/storage/out");
    expect(hrefs).toContain("/warehouse/materials");
  });

  it("shows the yard to everyone — installers most of all", () => {
    for (const role of ["installer", "foreman"] as const) {
      const el = mount({ packages: [], locations: [], role });
      expect(el.querySelector('[data-testid="yard-box"]'), `${role} should see the yard`).not.toBeNull();
    }
  });
});
