import { describe, expect, it } from "vitest";
import type { StoragePackage } from "../storage";
import {
  finalizedProjectIds, hideFinalized, historyRows, idsToSend, leftoverBlock, LOOSE, sendSummary, siteUnits,
} from "./sendToSite";

const pkg = (id: string, over: Partial<StoragePackage> = {}): StoragePackage => ({
  id, serial: `PKG-${id}`, short_code: null, status: "stored", project_id: "j1", category: null, note: null,
  delivery_id: null, container_id: "c7", bound_at: "2026-09-01T00:00:00Z", bound_by: null,
  created_at: "2026-08-10T00:00:00Z", package_marks: [], ...over,
});
const boxes = new Map([["c7", { name: "Conex 7" }], ["b1", { name: "ESH-18 bay" }]]);
const packages = [
  pkg("a", { package_marks: [{ mark_code: "16" }] }),
  pkg("b", { package_marks: [{ mark_code: "16" }], container_id: "b1" }),
  pkg("c", { package_marks: [{ mark_code: "2" }], status: "received", container_id: null }),
  pkg("d", { package_marks: [{ mark_code: "9" }], status: "checked_out", container_id: null }),
  pkg("e", { package_marks: [{ mark_code: "9" }], status: "minted", container_id: null }),
  pkg("f", { tracking: "pooled", piece_count: 4 }),
  pkg("g", { project_id: "j2", package_marks: [{ mark_code: "1" }] }),
];

describe("what of a job is here to send", () => {
  it("groups the pieces here by window, in number order, loose last; not what left or never came", () => {
    const units = siteUnits(packages, "j1", boxes);
    expect(units.map((u) => u.key)).toEqual(["2", "16", LOOSE]);
    const w16 = units[1];
    expect(w16.here).toBe(2);
    expect(w16.places).toEqual(["Conex 7", "ESH-18 bay"]);
    expect(units[0].places).toEqual(["not in a box yet"]);
    expect(units[2].here).toBe(4); // a pooled row counts what rides in it
  });
  it("sends every piece except the units held back", () => {
    const units = siteUnits(packages, "j1", boxes);
    expect(idsToSend(units, new Set()).sort()).toEqual(["a", "b", "c", "f"]);
    expect(idsToSend(units, new Set(["16"])).sort()).toEqual(["c", "f"]);
  });
  it("says what is about to happen in one line", () => {
    const units = siteUnits(packages, "j1", boxes);
    expect(sendSummary(units, new Set())).toBe("Move 2 units (7 pieces) to the job site");
    expect(sendSummary(units, new Set(["16"]))).toBe("Move 1 unit (5 pieces) to the job site · 1 stays");
    expect(sendSummary(units, new Set(["16", "2", LOOSE]))).toBe("Nothing picked to go.");
  });
});

describe("finalizing", () => {
  it("is blocked while anything of the job is still here, naming the boxes", () => {
    expect(leftoverBlock(packages, "j1", boxes)).toBe(
      "4 packages are still in the warehouse (Conex 7 ×2, ESH-18 bay ×1, not in a box yet ×1). Send them to the job site or move them to the Boneyard first.",
    );
    expect(leftoverBlock(packages.filter((p) => p.status === "checked_out"), "j1", boxes)).toBeNull();
    expect(leftoverBlock([pkg("z", { status: "received", container_id: null })], "j1", boxes)).toBe(
      "1 package is still in the warehouse (not in a box yet ×1). Send them to the job site or move them to the Boneyard first.",
    );
  });
  it("hides a finalized job's material from the warehouse but never the Boneyard", () => {
    const done = finalizedProjectIds([{ id: "j1", materials_finalized_at: "2026-09-06T00:00:00Z" }, { id: "j2" }]);
    const kept = hideFinalized([...packages, pkg("bone", { project_id: null })], done);
    expect(kept.map((p) => p.id)).toEqual(["g", "bone"]);
  });
  it("lists finalized jobs newest first with what went to site", () => {
    const rows = historyRows(
      [
        { id: "j1", job_code: "ESH-18", name: "Eshelman", materials_finalized_at: "2026-09-06T10:00:00Z" },
        { id: "j2", job_code: "DON117", name: "Don", materials_finalized_at: "2026-09-07T10:00:00Z" },
        { id: "j3", job_code: "OPEN", name: "Open" },
      ],
      packages,
    );
    expect(rows.map((r) => r.jobCode)).toEqual(["DON117", "ESH-18"]);
    expect(rows[1]).toMatchObject({ units: 3, onSite: 1 });
  });
});
