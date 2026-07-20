import { describe, expect, it } from "vitest";
import {
  bottomBarForRole,
  canAccess,
  menuForRole,
  roleRank,
} from "./nav";
import type { CrewRole } from "./install/types";

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

describe("bottomBarForRole (phone bottom bar)", () => {
  const linkTos = (role: CrewRole) =>
    bottomBarForRole(role)
      .filter((t): t is Extract<typeof t, { kind: "link" }> => t.kind === "link")
      .map((t) => t.to);

  it("gives installers exactly the core loop: Today, Scan, Ask", () => {
    const labels = bottomBarForRole("installer")
      .filter((t): t is Extract<typeof t, { kind: "link" }> => t.kind === "link")
      .map((t) => t.label);
    expect(labels).toEqual(["Today", "Scan", "Ask"]);
  });

  it("always leads with a Menu button and includes a Clock control", () => {
    for (const role of ["installer", "foreman", "supervisor", "owner"] as const) {
      const kinds = bottomBarForRole(role).map((t) => t.kind);
      expect(kinds[0], `menu should lead for ${role}`).toBe("menu");
      expect(kinds).toContain("clock");
    }
  });

  it("keeps manager-only surfaces off the installer bar", () => {
    const tos = linkTos("installer");
    for (const hidden of ["/projects", "/photos", "/warehouse", "/costing"]) {
      expect(tos).not.toContain(hidden);
    }
  });

  it("gives managers Jobs, Capture and Photos instead of the installer loop", () => {
    const foreman = bottomBarForRole("foreman");
    expect(foreman.some((t) => t.kind === "capture")).toBe(true);
    expect(linkTos("foreman")).toEqual(["/projects", "/photos"]);
    expect(linkTos("foreman")).not.toContain("/scan");
  });

  it("only links to destinations the role can access", () => {
    for (const role of ["installer", "foreman", "supervisor", "owner"] as const) {
      for (const to of linkTos(role)) {
        expect(canAccess(role, to), `${role} should reach ${to}`).toBe(true);
      }
    }
  });
});

describe("canAccess", () => {
  it("blocks installers from manager/supervisor/owner routes", () => {
    expect(canAccess("installer", "/costing")).toBe(false);
    expect(canAccess("installer", "/admin")).toBe(false);
    expect(canAccess("installer", "/qc")).toBe(false);
    expect(canAccess("installer", "/analytics")).toBe(false);
    expect(canAccess("installer", "/supplies")).toBe(false);
    expect(canAccess("installer", "/service")).toBe(false);
  });

  it("opens Service (warranty) to foreman+ only", () => {
    expect(canAccess("foreman", "/service")).toBe(true);
    expect(canAccess("supervisor", "/service")).toBe(true);
    expect(canAccess("owner", "/service")).toBe(true);
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

  it("gates the new Horizon-menu stub destinations by role", () => {
    // Installer-floor stubs everyone can reach.
    for (const p of ["/photos", "/completed-installs", "/milestones", "/first-pane", "/toolbox-history", "/profile", "/public-site"] as const) {
      expect(canAccess("installer", p)).toBe(true);
    }
    // Foreman-floor stubs blocked for installers.
    for (const p of ["/daily-logs", "/conditions", "/contacts"] as const) {
      expect(canAccess("installer", p)).toBe(false);
      expect(canAccess("foreman", p)).toBe(true);
    }
  });
});

describe("menuForRole (Horizon grouped menu)", () => {
  const flatten = (role: CrewRole) =>
    menuForRole(role).flatMap((s) => s.items);
  const titles = (role: CrewRole) =>
    menuForRole(role)
      .map((s) => s.title)
      .filter((t): t is string => !!t);

  it("labels the landing '/' as My Work for installers, Home for others", () => {
    const installerHome = flatten("installer").find((i) => i.to === "/");
    const ownerHome = flatten("owner").find((i) => i.to === "/");
    expect(installerHome?.label).toBe("My Work");
    expect(ownerHome?.label).toBe("Home");
  });

  it("always renders the Time tracking pill (clock action) for every role", () => {
    for (const role of ["installer", "foreman", "supervisor", "owner"] as const) {
      const pill = menuForRole(role).find((s) => s.title === "Time tracking");
      expect(pill?.pill, `Time tracking pill missing for ${role}`).toBe(true);
      expect(pill?.items.some((i) => i.action === "open-clock")).toBe(true);
    }
  });

  it("hides the Business pill from installers but shows it to managers", () => {
    expect(titles("installer")).not.toContain("Business");
    expect(titles("foreman")).toContain("Business");
    expect(titles("owner")).toContain("Business");
  });

  it("only surfaces destinations the role can actually access", () => {
    for (const role of ["installer", "foreman", "supervisor", "owner"] as const) {
      for (const item of flatten(role)) {
        if (item.to) {
          expect(canAccess(role, item.to), `${role} should reach ${item.to}`).toBe(true);
        }
      }
    }
  });

  it("keeps Admin (supervisor+) out of the installer/foreman menu", () => {
    expect(flatten("installer").map((i) => i.to)).not.toContain("/admin");
    expect(flatten("foreman").map((i) => i.to)).not.toContain("/admin");
    expect(flatten("supervisor").map((i) => i.to)).toContain("/admin");
    expect(flatten("owner").map((i) => i.to)).toContain("/admin");
  });

  it("exposes Infinity AI to everyone under Tools", () => {
    for (const role of ["installer", "foreman", "supervisor", "owner"] as const) {
      const ai = flatten(role).find((i) => i.to === "/ask");
      expect(ai?.label, `Infinity AI missing for ${role}`).toBe("Infinity AI");
    }
  });

  it("renders the Horizon section names", () => {
    const t = titles("owner");
    for (const name of ["Time tracking", "Business", "Company", "Tools", "Account"]) {
      expect(t).toContain(name);
    }
  });
});
