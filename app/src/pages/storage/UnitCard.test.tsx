// The unit card, rendered the way the app renders it — real component, real
// query cache, only the rows the server would have returned. Same reasoning
// as PackageSheet.test.tsx: a sentence has to come out of the shipped screen,
// not out of a helper called with a map somebody assembled in a test.

import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { StorageContainer, StoragePackage } from "../../lib/storage";
import { unitHref } from "../../lib/warehouse/materialsScope";
import { UnitCard } from "./UnitCard";

const conex: StorageContainer = {
  id: "conex",
  serial: "CTR-000007",
  name: "Conex 7",
  address: null,
  access_code: null,
  notes: null,
  active: true,
  created_at: "2026-08-17T00:00:00Z",
  parent_container_id: null,
  location_id: null,
};

function piece(over: Partial<StoragePackage> = {}): StoragePackage {
  return {
    id: "p1",
    serial: "PKG-000001",
    short_code: "AB1CDE",
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
    part_index: 1,
    part_total: 3,
    part_type: "frame",
    package_marks: [{ mark_code: "16" }],
    ...over,
  };
}

function render(pkgs: StoragePackage[], path = "/unit/job-1/16"): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  qc.setQueryData(["storagePackages"], pkgs);
  qc.setQueryData(["storageContainers"], [conex]);
  qc.setQueryData(["locations"], []);
  qc.setQueryData(["projects"], [{ id: "job-1", job_code: "BLACK22", name: "Black Desert" }]);
  qc.setQueryData(["projectsAll"], [{ id: "job-1", job_code: "BLACK22", name: "Black Desert" }]);
  qc.setQueryData(["partTypeOptions"], []);
  qc.setQueryData(["myRealProfile"], { id: "me", role: "installer" });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/unit/:projectId/:mark" element={<UnitCard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the unit card shows the unit as pieces", () => {
  const rows = [
    piece(),
    piece({ id: "p2", serial: "PKG-000002", short_code: "AB2CDE", part_index: 2, part_type: "glass", container_id: null, status: "received" }),
    piece({ id: "p3", serial: "PKG-000003", short_code: "AB3CDE", part_index: 3, part_type: "hardware", container_id: null, status: "minted" }),
  ];

  it("names the unit and says how many pieces are here", () => {
    const html = render(rows);
    expect(html).toContain("Window 16");
    expect(html).toContain("BLACK22");
    expect(html).toContain("2 of 3 here");
  });

  it("draws one tile per piece with its state as a tone", () => {
    const html = render(rows);
    expect(html).toContain("unit-piece--here");
    expect(html).toContain("unit-piece--soon");
    expect(html).toContain("Conex 7");
    expect(html).toContain("expected");
  });

  it("draws a ghost tile for a part number no label claims yet", () => {
    const html = render([piece(), piece({ id: "p3", serial: "PKG-000003", part_index: 3, part_type: "hardware" })]);
    expect(html).toContain("unit-piece--ghost");
    expect(html).toContain("no label yet");
  });

  it("offers the count chip only on a built job", () => {
    const html = render(rows, "/unit/waiting/5050?pending=Sunset%20Ridge%204");
    expect(html).toContain("Sunset Ridge 4");
  });
});

describe("the unit card's address", () => {
  it("is the job and the window number", () => {
    expect(unitHref({ projectId: "job-1" }, "16")).toBe("/unit/job-1/16");
  });
  it("carries a waiting job by name", () => {
    expect(unitHref({ projectId: null, pendingName: "Sunset Ridge 4" }, "5050")).toBe(
      "/unit/waiting/5050?pending=Sunset%20Ridge%204",
    );
  });
});
