import { describe, expect, it } from "vitest";
import {
  NAV,
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

  it("gives managers Jobs, Capture and one-tap Ask (Photos moved to the menu)", () => {
    const foreman = bottomBarForRole("foreman");
    expect(foreman.some((t) => t.kind === "capture")).toBe(true);
    expect(linkTos("foreman")).toEqual(["/projects", "/ask"]);
    expect(linkTos("foreman")).not.toContain("/scan");
    expect(linkTos("foreman")).not.toContain("/photos");
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
    expect(canAccess("installer", "/service")).toBe(false);
  });

  it("opens Supplies to installers — they are the ones taking the caulk", () => {
    // Ticket 07/08: an installer finds the supply and logs what they took.
    // Setting a home spot stays foreman+, enforced by set_supply_home.
    expect(canAccess("installer", "/supplies")).toBe(true);
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

  it("labels Ask canonically in the manager menu and drops it from the installer drawer", () => {
    for (const role of ["foreman", "supervisor", "owner"] as const) {
      const ai = flatten(role).find((i) => i.to === "/ask");
      expect(ai?.label, `Ask missing for ${role}`).toBe("Ask");
    }
    // Installers reach Ask on the bottom bar, so it's not duplicated in the drawer.
    expect(flatten("installer").map((i) => i.to)).not.toContain("/ask");
  });

  it("surfaces My Work and Photos in the manager menu (drawer/bottom-bar parity)", () => {
    const tos = flatten("foreman").map((i) => i.to);
    expect(tos).toContain("/my-work");
    expect(tos).toContain("/photos");
  });

  it("trims the installer drawer to a daily loop plus a collapsible More, minus Scan/Ask", () => {
    const sections = menuForRole("installer");
    const tos = sections.flatMap((s) => s.items).map((i) => i.to);
    expect(tos).not.toContain("/scan");
    expect(tos).not.toContain("/ask");
    const more = sections.find((s) => s.title === "More");
    expect(more?.collapsible).toBe(true);
    expect(more?.defaultOpen).toBe(false);
    expect((more?.items.length ?? 0) > 0).toBe(true);
  });

  it("renders the regrouped Horizon section names", () => {
    const t = titles("owner");
    for (const name of [
      "Time tracking",
      "Business",
      "Warehouse",
      "Problems & quality",
      "Fleet",
      "People",
      "Learning",
      "AI",
      "Account",
    ]) {
      expect(t).toContain(name);
    }
  });
});

describe("the warehouse is one row", () => {
  // Ticket 08's whole point: eight rows were the symptom of two location
  // models. If a row creeps back here, the page stopped holding the job.
  it("shows exactly one warehouse row, for every role that has it", () => {
    for (const role of ["installer", "foreman", "supervisor", "owner"] as const) {
      const section = menuForRole(role).find((s) => s.title === "Warehouse");
      if (!section) continue;
      expect(section.items.map((i) => i.to), `${role} sees more than one row`).toEqual([
        "/warehouse",
      ]);
    }
  });

  it("catalog moved to Account — importing types is data admin, not warehouse", () => {
    const account = menuForRole("owner").find((s) => s.title === "Account");
    expect(account?.items.map((i) => i.to)).toContain("/catalog");
  });
});

describe("the storage hub is one door with one rule (D6)", () => {
  // The hub page kept "Coming in" and "In storage" to foreman and up, while
  // /storage handed the same tools to anyone who typed the address. Two doors
  // to the same room with different locks is how the drift started, so the
  // hub's rule is the rule.
  it("keeps the container hub to foreman and up", () => {
    expect(canAccess("installer", "/storage")).toBe(false);
    expect(canAccess("foreman", "/storage")).toBe(true);
    expect(canAccess("supervisor", "/storage")).toBe(true);
    expect(canAccess("owner", "/storage")).toBe(true);
  });

  it("leaves tagging and check-out with the installers who do them", () => {
    // Installers tag at the truck and check packages out on their own screens.
    // Raising these would take the work off the people doing it.
    expect(canAccess("installer", "/storage/tag")).toBe(true);
    expect(canAccess("installer", "/storage/out")).toBe(true);
    expect(canAccess("installer", "/storage/arrive")).toBe(true);
  });
});

describe("every NAV destination has a door", () => {
  // A registry entry with no menu row is a page nobody can find — /data
  // shipped exactly that way (route + gating live, zero UI path to it, PR
  // #305). This freezes the intentional exceptions; anything new that lands
  // here is a missing MENU_DEF row, not a candidate for this list.
  const INTENTIONALLY_MENU_LESS = [
    "/clock", // lives as the clock ACTION in the menu + bottom bar, never a row
    "/search", // header search icon in Layout
    // Horizon stubs / in-page destinations (profile via Account, toolbox
    // history via the clock sheet, the rest "Coming soon" or project-scoped).
    "/daily-logs",
    "/completed-installs",
    "/milestones",
    "/first-pane",
    "/toolbox-history",
    "/conditions",
    "/contacts",
    "/profile",
    "/public-site",
    // Warehouse ticket 08: the eight warehouse rows collapsed to one page.
    // These are NOT orphans — /warehouse links every one of them from the
    // section it belongs to (tagging and receiving under "Coming in", the
    // containers under "In storage", check-out under "Going out", supplies
    // and counting under their own sections, and the unit-system tools
    // under "Other tools"). They lost their menu rows, not their doors.
    "/storage",
    "/receive",
    "/labels",
    "/supplies",
    // Ticket 08b: the arrival check is reached from the warehouse page's
    // Going out section. It is an occasional damage report, not a daily
    // destination, and a menu row would oversell it.
    "/storage/arrive",
    "/storage/tag",
    "/storage/out",
  ];

  it("every other NAV path appears in some role's menu or bottom bar", () => {
    const reachable = new Set<string>();
    for (const role of ["installer", "foreman", "supervisor", "owner"] as const) {
      for (const s of menuForRole(role))
        for (const item of s.items) if (item.to) reachable.add(item.to);
      for (const tab of bottomBarForRole(role))
        if ("to" in tab) reachable.add(tab.to);
    }
    const orphans = NAV.filter(
      (d) => !reachable.has(d.to) && !INTENTIONALLY_MENU_LESS.includes(d.to),
    ).map((d) => d.to);
    expect(orphans).toEqual([]);
  });

  it("the allowlist stays honest: nothing on it has quietly gained a menu row", () => {
    const reachable = new Set<string>();
    for (const role of ["installer", "foreman", "supervisor", "owner"] as const) {
      for (const s of menuForRole(role))
        for (const item of s.items) if (item.to) reachable.add(item.to);
      for (const tab of bottomBarForRole(role))
        if ("to" in tab) reachable.add(tab.to);
    }
    expect(INTENTIONALLY_MENU_LESS.filter((p) => reachable.has(p))).toEqual([]);
  });
});
