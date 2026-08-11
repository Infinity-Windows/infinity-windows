import { describe, expect, it } from "vitest";
import {
  APP_GUIDE,
  appGuideForRole,
  guideRank,
  issuesScopeForRole,
  renderAppGuide,
  type GuideRole,
} from "../../../supabase/functions/_shared/appGuide";
import { NAV } from "./nav";
import { roleRank } from "./install/types";

// Guide entries that intentionally exist beyond the canonical NAV registry
// (real installer-level routes that live only in the menu, not the NAV list).
const EXTRA_GUIDE_PATHS = new Set(["/my-work", "/settings"]);

describe("guideRank (mirrors install/types roleRank exactly)", () => {
  it("ranks the four real roles and legacy aliases the same as roleRank", () => {
    for (const role of [
      "installer",
      "foreman",
      "supervisor",
      "owner",
      "lead",
      "admin",
      "big_boss",
    ]) {
      expect(guideRank(role)).toBe(roleRank(role));
    }
  });

  it("defaults unknown/null/undefined to the installer floor (0)", () => {
    expect(guideRank(null)).toBe(0);
    expect(guideRank(undefined)).toBe(0);
    expect(guideRank("mystery")).toBe(0);
    expect(guideRank(null)).toBe(roleRank(null));
  });
});

describe("APP_GUIDE stays in sync with the nav registry", () => {
  it("covers every NAV destination with a matching minRole and a blurb", () => {
    const byPath = new Map(APP_GUIDE.map((e) => [e.path, e]));
    for (const dest of NAV) {
      const entry = byPath.get(dest.to);
      expect(entry, `missing app-guide entry for ${dest.to}`).toBeDefined();
      expect(entry!.minRole, `minRole drift for ${dest.to}`).toBe(dest.minRole);
      expect(entry!.blurb.length, `empty blurb for ${dest.to}`).toBeGreaterThan(0);
    }
  });

  it("has no unexpected extra entries beyond NAV + the known menu-only routes", () => {
    const navPaths = new Set(NAV.map((d) => d.to as string));
    const extras = APP_GUIDE.filter(
      (e) => !navPaths.has(e.path) && !EXTRA_GUIDE_PATHS.has(e.path),
    );
    expect(extras.map((e) => e.path)).toEqual([]);
  });

  it("has unique paths", () => {
    const paths = APP_GUIDE.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("appGuideForRole (role filtering)", () => {
  const paths = (role: GuideRole | string | null) =>
    appGuideForRole(role).map((e) => e.path);

  it("gives an installer only installer-floor tabs (no manager/owner tabs)", () => {
    const p = paths("installer");
    expect(p).toContain("/");
    expect(p).toContain("/warehouse");
    expect(p).toContain("/my-schedule");
    // never manager/owner destinations
    expect(p).not.toContain("/team");
    expect(p).not.toContain("/issues");
    expect(p).not.toContain("/scheduling");
    expect(p).not.toContain("/costing");
  });

  it("widens as role increases and is strictly cumulative", () => {
    const installer = appGuideForRole("installer").length;
    const foreman = appGuideForRole("foreman").length;
    const supervisor = appGuideForRole("supervisor").length;
    const owner = appGuideForRole("owner").length;
    expect(foreman).toBeGreaterThan(installer);
    expect(supervisor).toBeGreaterThan(foreman);
    expect(owner).toBeGreaterThan(supervisor);
    // owner sees the whole guide
    expect(owner).toBe(APP_GUIDE.length);
  });

  it("gives foreman coordination tabs but never supervisor/owner tabs", () => {
    const p = paths("foreman");
    expect(p).toContain("/team");
    expect(p).toContain("/issues");
    expect(p).toContain("/qc");
    // Foremen read the crew board (2026-08-11); editing stays supervisor+ in-page.
    expect(p).toContain("/scheduling");
    expect(p).not.toContain("/admin");
    expect(p).not.toContain("/costing");
  });

  it("gates the owner-only Cost tab to owners only", () => {
    expect(paths("supervisor")).not.toContain("/costing");
    expect(paths("owner")).toContain("/costing");
  });

  it("treats an unknown/null role as installer (never over-exposes)", () => {
    expect(paths(null)).toEqual(paths("installer"));
    expect(paths("mystery")).toEqual(paths("installer"));
  });
});

describe("issuesScopeForRole (matches the in-app foreman+ Issues gate)", () => {
  it("gives foreman+ the company-wide open list, regardless of jobs on", () => {
    for (const role of ["foreman", "supervisor", "owner", "lead", "admin", "big_boss"]) {
      expect(issuesScopeForRole(role, 0)).toBe("company");
      expect(issuesScopeForRole(role, 5)).toBe("company");
    }
  });

  it("scopes an installer to their own jobs only (never company-wide)", () => {
    expect(issuesScopeForRole("installer", 3)).toBe("own-jobs");
    // an installer on no jobs gets nothing — no company issues leak
    expect(issuesScopeForRole("installer", 0)).toBe("none");
  });

  it("treats an unknown/null role as an installer (never over-exposes)", () => {
    expect(issuesScopeForRole(null, 2)).toBe("own-jobs");
    expect(issuesScopeForRole(undefined, 0)).toBe("none");
    expect(issuesScopeForRole("mystery", 0)).toBe("none");
    // crucially, an unknown role NEVER gets the company-wide list
    expect(issuesScopeForRole("mystery", 9)).toBe("own-jobs");
  });
});

describe("renderAppGuide", () => {
  it("renders one bullet per tab with label, path and blurb", () => {
    const text = renderAppGuide(appGuideForRole("installer"));
    expect(text).toContain("Home (/):");
    expect(text).toContain("Ask (/ask):");
    expect(text.split("\n").length).toBe(appGuideForRole("installer").length);
  });

  it("is empty for an empty list", () => {
    expect(renderAppGuide([])).toBe("");
  });
});
