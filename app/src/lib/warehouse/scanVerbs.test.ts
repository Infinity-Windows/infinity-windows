import { describe, expect, it } from "vitest";
import type { StorageContainer, StoragePackage } from "../storage";
import { primaryVerb, restOfUnitBox, scanVerbs, verbsForMany } from "./scanVerbs";

const box = (id: string, name: string): StorageContainer => ({
  id, serial: `CTR-${id}`, name, address: null, access_code: null, notes: null,
  active: true, created_at: "2026-08-01T00:00:00Z",
});
const containers = new Map([box("c7", "Conex 7"), box("c3", "Conex 3")].map((c) => [c.id, c]));

const pkg = (over: Partial<StoragePackage> = {}): StoragePackage => ({
  id: "p1", serial: "PKG-000001", short_code: "AB1CDE", status: "received", project_id: "job-1",
  category: null, note: null, delivery_id: null, container_id: null, bound_at: null, bound_by: null,
  created_at: "2026-08-10T12:00:00Z", package_marks: [{ mark_code: "16" }], ...over,
});

describe("the verb a scan leads with", () => {
  it("a blank sticker wants tagging", () => {
    expect(primaryVerb(scanVerbs(pkg({ status: "blank" }), [], containers))?.id).toBe("tag");
  });
  it("an expected package has arrived", () => {
    expect(primaryVerb(scanVerbs(pkg({ status: "minted" }), [], containers))?.id).toBe("arrive");
  });
  it("a loose package gets put away", () => {
    expect(primaryVerb(scanVerbs(pkg(), [], containers))?.id).toBe("put_away");
  });
  it("a stored package moves or checks out, fix last", () => {
    const v = scanVerbs(pkg({ status: "stored", container_id: "c7" }), [], containers);
    expect(v.map((x) => x.id)).toEqual(["move", "check_out", "fix"]);
  });
  it("a package out on a job comes back in", () => {
    expect(primaryVerb(scanVerbs(pkg({ status: "checked_out" }), [], containers))?.id).toBe("back_in");
  });
});

describe("put with the rest", () => {
  const rest = [
    pkg({ id: "p2", serial: "PKG-000002", status: "stored", container_id: "c7" }),
    pkg({ id: "p3", serial: "PKG-000003", status: "stored", container_id: "c7" }),
  ];
  it("leads when the unit's other pieces all sit in one box", () => {
    const v = scanVerbs(pkg(), rest, containers);
    expect(v[0]).toMatchObject({ id: "put_with_rest", containerId: "c7", hint: "Conex 7" });
    expect(v[0].label).toContain("window 16");
  });
  it("is not offered when the rest is split across boxes", () => {
    const split = [rest[0], { ...rest[1], container_id: "c3" }];
    expect(restOfUnitBox(pkg(), split)).toBeNull();
  });
  it("is not offered when this piece is already with the rest", () => {
    expect(restOfUnitBox(pkg({ status: "stored", container_id: "c7" }), rest)).toBeNull();
  });
  it("ignores other jobs' window 16", () => {
    const other = rest.map((r) => ({ ...r, project_id: "job-2" }));
    expect(restOfUnitBox(pkg(), other)).toBeNull();
  });
});

describe("several scans at once", () => {
  it("all expected → arrive them all", () => {
    const v = verbsForMany([pkg({ status: "minted" }), pkg({ id: "p2", status: "minted" })]);
    expect(v.map((x) => x.id)).toEqual(["arrive"]);
  });
  it("arrived and stored mix → put away and check out", () => {
    const v = verbsForMany([pkg(), pkg({ id: "p2", status: "stored", container_id: "c7" })]);
    expect(v.map((x) => x.id)).toEqual(["put_away", "check_out"]);
  });
  it("an expected one in the mix blocks put-away, and nothing checks out", () => {
    const v = verbsForMany([pkg(), pkg({ id: "p2", status: "minted" })]);
    expect(v).toEqual([]);
  });
});
