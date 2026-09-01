import { describe, expect, it } from "vitest";
import { effectiveRole, previewableRoles } from "./viewAsRoleContext";
import type { ViewAsRoleValue } from "./viewAsRoleContext";

/**
 * The view-as ceiling (owner bug report, 2026-09-01): a supervisor could open
 * the "view as role" picker and preview OWNER, and effectiveRole rendered the
 * owner UI for them. Rank order is installer(0) < foreman(1) < supervisor(2)
 * < owner(3); the rule is "same rank and below, that's it."
 *
 * The bug was that `effectiveRole()` trusted `previewRole`/`previewPerson.role`
 * completely once `canPreview`/`canPreviewPerson` passed — those flags only
 * gate WHETHER a preview may be attempted, never WHICH role may be reached.
 * A stale sessionStorage value (or a forged one, or a future picker bug that
 * lets a lower rank slip a higher role into state) sailed straight through.
 *
 * This is the seam: effectiveRole is pure and is the single function every
 * route guard, nav, and page gates on via useEffectiveRole — fixing the clamp
 * here closes the hole everywhere at once, independent of the picker UI.
 */
function view(partial: Partial<ViewAsRoleValue>): Pick<ViewAsRoleValue, "previewRole" | "canPreview"> &
  Partial<Pick<ViewAsRoleValue, "previewPerson" | "canPreviewPerson">> {
  return {
    previewRole: null,
    canPreview: false,
    previewPerson: null,
    canPreviewPerson: false,
    ...partial,
  };
}

describe("effectiveRole — the view-as ceiling", () => {
  it("clamps a supervisor's stored owner preview back to supervisor", () => {
    const result = effectiveRole("supervisor", view({ canPreview: true, previewRole: "owner" }));
    expect(result).toBe("supervisor");
  });

  it("lets an owner preview installer (below rank — legitimate)", () => {
    const result = effectiveRole("owner", view({ canPreview: true, previewRole: "installer" }));
    expect(result).toBe("installer");
  });

  it("clamps a foreman's stored supervisor preview back to foreman", () => {
    // Foreman never gets canPreview true in the real app (supervisor+ only),
    // but the clamp must hold even if that gate is ever loosened or bypassed.
    const result = effectiveRole("foreman", view({ canPreview: true, previewRole: "supervisor" }));
    expect(result).toBe("foreman");
  });

  it("lets a supervisor preview their own rank and below (foreman, installer)", () => {
    expect(effectiveRole("supervisor", view({ canPreview: true, previewRole: "supervisor" }))).toBe(
      "supervisor",
    );
    expect(effectiveRole("supervisor", view({ canPreview: true, previewRole: "foreman" }))).toBe(
      "foreman",
    );
    expect(effectiveRole("supervisor", view({ canPreview: true, previewRole: "installer" }))).toBe(
      "installer",
    );
  });

  it("clamps a forged owner-rank previewPerson for anyone who isn't actually owner", () => {
    // Defense in depth: canPreviewPerson is owner-only today, but the clamp
    // must not rely on that gate alone — it must hold on rank, not on trust
    // that the caller checked first.
    const result = effectiveRole(
      "supervisor",
      view({
        canPreviewPerson: true,
        previewPerson: { id: "eve", name: "Eve", role: "owner" },
      }),
    );
    expect(result).toBe("supervisor");
  });

  it("still lets a real owner preview any person (their rank covers everyone)", () => {
    const result = effectiveRole(
      "owner",
      view({
        canPreviewPerson: true,
        previewPerson: { id: "chris", name: "Chris", role: "installer" },
      }),
    );
    expect(result).toBe("installer");
  });

  it("falls back to realRole when not previewing at all", () => {
    expect(effectiveRole("foreman", view({}))).toBe("foreman");
  });
});

describe("previewableRoles — the picker's option list", () => {
  it("owner sees all four roles", () => {
    expect(previewableRoles("owner")).toEqual(["installer", "foreman", "supervisor", "owner"]);
  });

  it("supervisor sees supervisor, foreman, installer — never owner", () => {
    expect(previewableRoles("supervisor")).toEqual(["installer", "foreman", "supervisor"]);
  });

  it("foreman sees foreman, installer only", () => {
    expect(previewableRoles("foreman")).toEqual(["installer", "foreman"]);
  });

  it("installer sees only installer", () => {
    expect(previewableRoles("installer")).toEqual(["installer"]);
  });

  it("unknown/null role defaults to installer-min, same as roleRank", () => {
    expect(previewableRoles(null)).toEqual(["installer"]);
    expect(previewableRoles(undefined)).toEqual(["installer"]);
  });
});
