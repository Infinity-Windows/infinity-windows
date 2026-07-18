import { describe, expect, it } from "vitest";
import {
  isForemanPlus,
  isOwner,
  isSupervisorPlus,
  roleRank,
} from "./install/types";
import { minRoleForPath } from "./nav";

/**
 * Cross-wave interaction guard: the role helpers and the nav registry must never
 * disagree about who can reach what. Both derive from the single `roleRank`
 * source of truth in install/types, so this asserts they stay in lockstep and
 * that the old inversion (isForemanPlus("mystery") returning true while
 * roleRank("mystery") was 0) can never come back.
 */
describe("roleRank ordering and legacy mappings", () => {
  it("ranks the four canonical roles", () => {
    expect(roleRank("installer")).toBe(0);
    expect(roleRank("foreman")).toBe(1);
    expect(roleRank("supervisor")).toBe(2);
    expect(roleRank("owner")).toBe(3);
  });

  it("maps legacy names and floors unknown/null to installer", () => {
    expect(roleRank("lead")).toBe(1);
    expect(roleRank("admin")).toBe(2);
    expect(roleRank("big_boss")).toBe(3);
    expect(roleRank("mystery")).toBe(0);
    expect(roleRank(null)).toBe(0);
    expect(roleRank(undefined)).toBe(0);
  });
});

describe("role helpers derive from roleRank", () => {
  it("isForemanPlus is roleRank >= 1", () => {
    expect(isForemanPlus("mystery")).toBe(false);
    expect(isForemanPlus("installer")).toBe(false);
    expect(isForemanPlus(null)).toBe(false);
    expect(isForemanPlus("foreman")).toBe(true);
    expect(isForemanPlus("lead")).toBe(true);
    expect(isForemanPlus("supervisor")).toBe(true);
    expect(isForemanPlus("owner")).toBe(true);
  });

  it("isSupervisorPlus is roleRank >= 2", () => {
    expect(isSupervisorPlus("foreman")).toBe(false);
    expect(isSupervisorPlus("mystery")).toBe(false);
    expect(isSupervisorPlus("supervisor")).toBe(true);
    expect(isSupervisorPlus("admin")).toBe(true);
    expect(isSupervisorPlus("owner")).toBe(true);
  });

  it("isOwner is roleRank >= 3", () => {
    expect(isOwner("supervisor")).toBe(false);
    expect(isOwner("owner")).toBe(true);
    expect(isOwner("big_boss")).toBe(true);
  });

  it("stays consistent with roleRank across all inputs", () => {
    for (const role of [
      "installer",
      "foreman",
      "supervisor",
      "owner",
      "lead",
      "admin",
      "big_boss",
      "mystery",
      null,
      undefined,
    ]) {
      expect(isForemanPlus(role)).toBe(roleRank(role) >= 1);
      expect(isSupervisorPlus(role)).toBe(roleRank(role) >= 2);
      expect(isOwner(role)).toBe(roleRank(role) >= 3);
    }
  });
});

describe("minRoleForPath matches page-level gating", () => {
  it("guards foreman+ surfaces at the foreman floor", () => {
    for (const path of [
      "/qc",
      "/analytics",
      "/crew",
      "/training",
      "/receive",
      "/labels",
      "/catalog",
      "/supplies",
      "/team",
      "/issues",
    ]) {
      expect(minRoleForPath(path)).toBe("foreman");
    }
  });

  it("keeps admin + heartbeat supervisor+ and costing owner-only", () => {
    expect(minRoleForPath("/admin")).toBe("supervisor");
    expect(minRoleForPath("/heartbeat")).toBe("supervisor");
    expect(minRoleForPath("/costing")).toBe("owner");
  });
});
