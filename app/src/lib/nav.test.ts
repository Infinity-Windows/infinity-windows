import { describe, expect, it } from "vitest";
import { canAccess, navForRole, roleRank } from "./nav";

describe("roleRank", () => {
  it("ranks the four roles", () => {
    expect(roleRank("installer")).toBe(0);
    expect(roleRank("foreman")).toBe(1);
    expect(roleRank("supervisor")).toBe(2);
    expect(roleRank("owner")).toBe(3);
  });

  it("maps legacy names and defaults unknown/null to installer-min", () => {
    expect(roleRank("lead")).toBe(1);
    expect(roleRank("admin")).toBe(2);
    expect(roleRank("big_boss")).toBe(3);
    expect(roleRank(null)).toBe(0);
    expect(roleRank(undefined)).toBe(0);
    expect(roleRank("mystery")).toBe(0);
  });
});

describe("navForRole", () => {
  it("gives installers exactly the execution set in order", () => {
    const labels = navForRole("installer").rail.map((i) => i.label);
    expect(labels).toEqual([
      "My Work",
      "Time",
      "Learn",
      "Safety",
      "Points",
      "Scan",
      "Tools",
    ]);
  });

  it("hides manager-only surfaces from installers", () => {
    const labels = navForRole("installer").rail.map((i) => i.label);
    for (const hidden of ["Warehouse", "Quality", "Team", "Admin", "Cost"]) {
      expect(labels).not.toContain(hidden);
    }
  });

  it("labels the installer landing as My Work but managers as Home", () => {
    const installerHome = navForRole("installer").rail.find((i) => i.to === "/");
    const managerHome = navForRole("foreman").rail.find((i) => i.to === "/");
    expect(installerHome?.label).toBe("My Work");
    expect(managerHome?.label).toBe("Home");
  });

  it("puts Cost on the owner phone bar and Warehouse into More", () => {
    const owner = navForRole("owner");
    expect(owner.phone.map((i) => i.to)).toContain("/costing");
    expect(owner.more.map((i) => i.to)).toContain("/warehouse");
    expect(owner.phone.map((i) => i.to)).not.toContain("/warehouse");
  });

  it("adds Admin to More for supervisors and owners only", () => {
    expect(navForRole("foreman").rail.map((i) => i.to)).not.toContain("/admin");
    expect(navForRole("supervisor").more.map((i) => i.to)).toContain("/admin");
    expect(navForRole("owner").more.map((i) => i.to)).toContain("/admin");
  });

  it("surfaces Issues for foreman+ (and up) but never installers", () => {
    expect(navForRole("installer").rail.map((i) => i.to)).not.toContain("/issues");
    expect(navForRole("foreman").rail.map((i) => i.to)).toContain("/issues");
    expect(navForRole("supervisor").rail.map((i) => i.to)).toContain("/issues");
    expect(navForRole("owner").rail.map((i) => i.to)).toContain("/issues");
  });

  it("surfaces Heartbeat for supervisor+ only, on their phone bar", () => {
    expect(navForRole("installer").rail.map((i) => i.to)).not.toContain("/heartbeat");
    expect(navForRole("foreman").rail.map((i) => i.to)).not.toContain("/heartbeat");
    expect(navForRole("supervisor").rail.map((i) => i.to)).toContain("/heartbeat");
    expect(navForRole("owner").rail.map((i) => i.to)).toContain("/heartbeat");
    expect(navForRole("supervisor").phone.map((i) => i.to)).toContain("/heartbeat");
    expect(navForRole("owner").phone.map((i) => i.to)).toContain("/heartbeat");
  });
});

describe("canAccess", () => {
  it("blocks installers from manager/supervisor/owner routes", () => {
    expect(canAccess("installer", "/costing")).toBe(false);
    expect(canAccess("installer", "/admin")).toBe(false);
    expect(canAccess("installer", "/qc")).toBe(false);
    expect(canAccess("installer", "/analytics")).toBe(false);
    expect(canAccess("installer", "/supplies")).toBe(false);
  });

  it("allows each role its floor and above", () => {
    expect(canAccess("foreman", "/qc")).toBe(true);
    expect(canAccess("supervisor", "/admin")).toBe(true);
    expect(canAccess("owner", "/costing")).toBe(true);
  });

  it("keeps costing owner-only", () => {
    expect(canAccess("foreman", "/costing")).toBe(false);
    expect(canAccess("supervisor", "/costing")).toBe(false);
  });

  it("keeps heartbeat supervisor+ (blocked for installers and foremen)", () => {
    expect(canAccess("installer", "/heartbeat")).toBe(false);
    expect(canAccess("foreman", "/heartbeat")).toBe(false);
    expect(canAccess("supervisor", "/heartbeat")).toBe(true);
    expect(canAccess("owner", "/heartbeat")).toBe(true);
  });

  it("leaves open + detail/legacy routes reachable for everyone", () => {
    expect(canAccess("installer", "/")).toBe(true);
    expect(canAccess("installer", "/warehouse")).toBe(true);
    expect(canAccess("installer", "/projects")).toBe(true);
    expect(canAccess("installer", "/w/abc123")).toBe(true);
    expect(canAccess("installer", "/projects/xyz/map")).toBe(true);
  });
});
