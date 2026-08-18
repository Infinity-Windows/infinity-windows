// The package sheet, rendered the way the app renders it.
//
// Why a render test and not another call to placeWhere with a map built by
// hand: "staged for BLACK22" was written, exported and unit-tested for weeks
// while no screen in the shipped app ever showed it. Every test that covered
// it typed out its own locations map, so the tests passed on a path production
// never took — nobody was loading locations at all.
//
// So this renders the real component, through the real query cache, and only
// seeds the rows the server would have returned. If the page stops asking for
// locations, or stops handing them to the label, the seeded rows go unread and
// this fails.

import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Location } from "../../lib/types";
import type { StorageContainer, StoragePackage } from "../../lib/storage";
import { PackageSheet } from "./PackageSheet";

const SERIAL = "PKG-000042";

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

function packageRow(over: Partial<StoragePackage> = {}): StoragePackage {
  return {
    id: "pkg-42",
    serial: SERIAL,
    short_code: "K4T9QP",
    status: "stored",
    project_id: "job-1",
    category: null,
    note: null,
    delivery_id: null,
    container_id: null,
    location_id: null,
    bound_at: null,
    bound_by: null,
    created_at: "2026-08-17T00:00:00Z",
    ...over,
  };
}

/**
 * Render the sheet with only what the server would have handed it. Anything
 * left out of `seed` is a query the component asked for and got nothing back
 * from — exactly what happens when a page forgets to load something.
 */
function render(seed: { pkg: StoragePackage; locations?: Location[] }): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  qc.setQueryData(["storagePackage", SERIAL], seed.pkg);
  qc.setQueryData(["storageContainers"], [conex]);
  qc.setQueryData(["projects"], [
    { id: "job-1", job_code: "BLACK22", name: "Black Desert" },
  ]);
  if (seed.locations) qc.setQueryData(["locations"], seed.locations);

  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/pkg/${SERIAL}`]}>
        <Routes>
          <Route path="/pkg/:serial" element={<PackageSheet />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the package sheet says where it is", () => {
  it("names the job a staged package is set aside for", () => {
    // The whole point of this test: the sentence has to come out of the REAL
    // screen, not out of a fixture somebody assembled in a test file.
    const html = render({
      pkg: packageRow({ container_id: null, location_id: "bay-1" }),
      locations: [bay],
    });
    expect(html).toContain("staged for BLACK22 — J-BLACK22-A");
  });

  it("falls back to a shelf only when the page really has no locations", () => {
    // Same package, same slot — the ONLY difference is that the locations
    // query returned nothing. This pins that the sentence above is read off
    // the query, not off the container name or anything else lying around.
    const html = render({
      pkg: packageRow({ container_id: null, location_id: "bay-1" }),
    });
    expect(html).not.toContain("staged for BLACK22");
    expect(html).toContain("on a shelf");
  });

  it("still names the container when the package is in one", () => {
    const html = render({
      pkg: packageRow({ container_id: "conex" }),
      locations: [bay],
    });
    expect(html).toContain("Conex 3");
  });

  it("says loose plainly when there is no container and no slot", () => {
    const html = render({ pkg: packageRow(), locations: [bay] });
    expect(html).toContain("loose — no container, no slot");
  });
});

describe("the Boneyard on the sheet (tickets 17-18)", () => {
  it("a bound package with no job reads Boneyard, not silence", () => {
    const html = render({ pkg: packageRow({ project_id: null }) });
    expect(html).toContain("Boneyard");
  });

  it("a blank sticker is nobody's stock and says nothing", () => {
    const html = render({
      pkg: packageRow({ project_id: null, status: "blank" }),
    });
    expect(html).not.toContain("Boneyard");
  });

  it("a job's own package never reads Boneyard", () => {
    const html = render({ pkg: packageRow({}) });
    expect(html).toContain("BLACK22");
    expect(html).not.toContain("Boneyard");
  });
});
