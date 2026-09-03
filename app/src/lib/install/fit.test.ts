import { describe, expect, it } from "vitest";
import {
  checkFit,
  isInstallReadyStatus,
  openingReadiness,
  readyToInstall,
  smallest,
  DEFAULT_CLEARANCE,
  INSTALL_READY_STATUSES,
  type OpeningLike,
} from "./fit";

describe("checkFit", () => {
  it("returns unknown when inputs are missing", () => {
    expect(checkFit({ unitWidthIn: 30, unitHeightIn: 50, roWidthIn: null, roHeightIn: null }).verdict).toBe("unknown");
  });

  it("passes with proper shim clearance", () => {
    // Owner's rule (2026-08-11): overall gap between 1/8" and 1/2".
    // 30x50 unit, RO 30.375 x 50.375 => 0.375 total gap, within range.
    const r = checkFit({ unitWidthIn: 30, unitHeightIn: 50, roWidthIn: 30.375, roHeightIn: 50.375 });
    expect(r.verdict).toBe("fits");
    expect(r.widthGap).toBe(0.38); // round2
  });

  it("flags too_small as a hard stop", () => {
    const r = checkFit({ unitWidthIn: 30, unitHeightIn: 50, roWidthIn: 29.5, roHeightIn: 50.75 });
    expect(r.verdict).toBe("too_small");
    expect(r.message).toMatch(/flag the office/i);
  });

  it("flags tight when under min clearance", () => {
    // gap 1/16" total < the 1/8" minimum - won't shim in.
    const r = checkFit({ unitWidthIn: 30, unitHeightIn: 50, roWidthIn: 30.0625, roHeightIn: 50.375 });
    expect(r.verdict).toBe("tight");
  });

  it("flags too_big when over max clearance", () => {
    // gap 3/4" total > the 1/2" maximum - opening oversized.
    const r = checkFit({ unitWidthIn: 30, unitHeightIn: 50, roWidthIn: 30.75, roHeightIn: 50.375 });
    expect(r.verdict).toBe("too_big");
  });

  // The one-tap "Quick check: all good" (owner, 2026-09-02): a stand-in for a
  // measurement nobody took, and only that.
  describe("a quick check with no tape numbers", () => {
    it("answers fits, and says there are no numbers behind it", () => {
      const r = checkFit({
        unitWidthIn: 30,
        unitHeightIn: 50,
        roWidthIn: null,
        roHeightIn: null,
        roQuickOk: true,
      });
      expect(r.verdict).toBe("fits");
      expect(r.message).toBe("Quick check: all good — no tape numbers on file.");
      expect(r.widthGap).toBeNull();
      expect(r.heightGap).toBeNull();
    });

    it("speaks even when the unit's own size is unknown", () => {
      // A person judged the window against the hole. That judgment does not
      // need the catalog to have dimensions on file.
      const r = checkFit({
        unitWidthIn: null,
        unitHeightIn: null,
        roWidthIn: null,
        roHeightIn: null,
        roQuickOk: true,
      });
      expect(r.verdict).toBe("fits");
    });

    it("still answers unknown when nobody has tapped it", () => {
      const r = checkFit({
        unitWidthIn: 30,
        unitHeightIn: 50,
        roWidthIn: null,
        roHeightIn: null,
        roQuickOk: false,
      });
      expect(r.verdict).toBe("unknown");
    });

    it("changes nothing for a caller that never passes the flag", () => {
      expect(
        checkFit({ unitWidthIn: 30, unitHeightIn: 50, roWidthIn: null, roHeightIn: null })
          .verdict,
      ).toBe("unknown");
    });
  });

  describe("numbers on file outrank a quick check", () => {
    it("is ignored when the measurements say too_small", () => {
      const r = checkFit({
        unitWidthIn: 30,
        unitHeightIn: 50,
        roWidthIn: 29.5,
        roHeightIn: 50.375,
        roQuickOk: true,
      });
      expect(r.verdict).toBe("too_small");
    });

    it("is ignored when the measurements say tight", () => {
      const r = checkFit({
        unitWidthIn: 30,
        unitHeightIn: 50,
        roWidthIn: 30.0625,
        roHeightIn: 50.375,
        roQuickOk: true,
      });
      expect(r.verdict).toBe("tight");
    });

    it("is ignored when the measurements say too_big", () => {
      const r = checkFit({
        unitWidthIn: 30,
        unitHeightIn: 50,
        roWidthIn: 30.75,
        roHeightIn: 50.375,
        roQuickOk: true,
      });
      expect(r.verdict).toBe("too_big");
    });

    it("reports the real gaps, not the quick check, when the numbers do fit", () => {
      const r = checkFit({
        unitWidthIn: 30,
        unitHeightIn: 50,
        roWidthIn: 30.375,
        roHeightIn: 50.375,
        roQuickOk: true,
      });
      expect(r.verdict).toBe("fits");
      expect(r.message).toBe('Fits: 0.38" width gap, 0.38" height gap.');
    });

    it("half a measurement is not a measurement — the quick check still speaks", () => {
      // A width with no height cannot be judged; the walk still happened.
      const r = checkFit({
        unitWidthIn: 30,
        unitHeightIn: 50,
        roWidthIn: 30.375,
        roHeightIn: null,
        roQuickOk: true,
      });
      expect(r.verdict).toBe("fits");
      expect(r.message).toMatch(/no tape numbers on file/);
    });
  });

  it("respects a custom clearance", () => {
    const r = checkFit({
      unitWidthIn: 30,
      unitHeightIn: 50,
      roWidthIn: 31.5,
      roHeightIn: 51.5,
      clearance: { minPerSide: 0.5, maxPerSide: 1 },
    });
    expect(r.verdict).toBe("fits");
  });
});

describe("smallest", () => {
  it("returns the smallest positive measurement", () => {
    expect(smallest([30.5, 30.25, 30.75])).toBe(30.25);
  });
  it("ignores nulls and non-positive values", () => {
    expect(smallest([null, 0, 48, undefined, 47.5])).toBe(47.5);
  });
  it("returns null when nothing valid", () => {
    expect(smallest([null, undefined])).toBeNull();
  });
});

describe("readyToInstall", () => {
  const base = {
    hasUnit: true,
    typeMatches: true,
    fit: "fits" as const,
    condition: "ok" as const,
    atLocationOrLoaded: true,
  };

  it("is ready when everything checks out", () => {
    expect(readyToInstall(base).status).toBe("ready");
  });

  it("blocks on wrong type", () => {
    expect(readyToInstall({ ...base, typeMatches: false }).status).toBe("blocked");
  });

  it("blocks on damaged", () => {
    expect(readyToInstall({ ...base, condition: "damaged" }).status).toBe("blocked");
  });

  it("blocks on too_small", () => {
    expect(readyToInstall({ ...base, fit: "too_small" }).status).toBe("blocked");
  });

  it("is incomplete when unmeasured or unchecked", () => {
    expect(readyToInstall({ ...base, fit: "unknown" }).status).toBe("incomplete");
    expect(readyToInstall({ ...base, condition: "unknown" }).status).toBe("incomplete");
    expect(readyToInstall({ ...base, hasUnit: false }).status).toBe("incomplete");
  });

  it("exposes default clearance constants (the owner's 1/8-to-1/2 overall rule)", () => {
    expect(DEFAULT_CLEARANCE.minPerSide).toBe(0.0625);
    expect(DEFAULT_CLEARANCE.maxPerSide).toBe(0.25);
  });
});

describe("isInstallReadyStatus", () => {
  it("treats a just-unloaded on_site unit as install-ready", () => {
    expect(isInstallReadyStatus("on_site")).toBe(true);
  });

  it("treats warehouse/staged/loaded units as install-ready", () => {
    expect(isInstallReadyStatus("in_warehouse")).toBe(true);
    expect(isInstallReadyStatus("staged")).toBe(true);
    expect(isInstallReadyStatus("loaded")).toBe(true);
  });

  it("rejects not-yet-on-hand or terminal statuses", () => {
    expect(isInstallReadyStatus("pre_issued")).toBe(false);
    expect(isInstallReadyStatus("inbound")).toBe(false);
    expect(isInstallReadyStatus("installed")).toBe(false);
    expect(isInstallReadyStatus(null)).toBe(false);
    expect(isInstallReadyStatus(undefined)).toBe(false);
  });

  it("lists on_site among the shared ready statuses", () => {
    expect(INSTALL_READY_STATUSES).toContain("on_site");
  });
});

describe("openingReadiness", () => {
  // Right unit, measured to fit, condition ok, unit assigned.
  const base: OpeningLike = {
    status: "assigned",
    assigned_window_id: "w1",
    window_type_id: "t-cas",
    condition: "ok",
    ro_width_in: 30.75,
    ro_height_in: 50.75,
    window_types: { width_in: 30, height_in: 50 },
    windows: { window_type_id: "t-cas", status: "staged" },
  };

  it("treats an on_site unit as install-ready", () => {
    const r = openingReadiness({
      ...base,
      windows: { window_type_id: "t-cas", status: "on_site" },
    });
    expect(r.status).toBe("ready");
  });

  it("still marks a not-yet-on-hand unit incomplete", () => {
    const r = openingReadiness({
      ...base,
      windows: { window_type_id: "t-cas", status: "pre_issued" },
    });
    expect(r.status).toBe("incomplete");
    expect(r.reasons.some((m) => /staged\/loaded\/on-site/i.test(m))).toBe(true);
  });

  // The whole point of the quick check: the dispatch board, MyWork and the
  // next-window pick read this function, so one tap has to clear
  // "Rough opening not measured." everywhere, not only on the sheet.
  it("a quick-checked opening with no numbers is ready", () => {
    const r = openingReadiness({
      ...base,
      ro_width_in: null,
      ro_height_in: null,
      ro_quick_ok: true,
    });
    expect(r.fit).toBe("fits");
    expect(r.status).toBe("ready");
  });

  it("without the tap, an unmeasured opening is still incomplete", () => {
    const r = openingReadiness({ ...base, ro_width_in: null, ro_height_in: null });
    expect(r.fit).toBe("unknown");
    expect(r.reasons).toContain("Rough opening not measured.");
  });

  it("a quick check cannot rescue an opening the tape says is too small", () => {
    const r = openingReadiness({
      ...base,
      ro_width_in: 29,
      ro_height_in: 50.375,
      ro_quick_ok: true,
    });
    expect(r.status).toBe("blocked");
  });
});

describe("specs must be checked before a window counts as ready", () => {
  // The docstring always said ready means "confirmed"; the calculation never
  // looked. So an unreviewed AI draft — dimensions nobody verified — could be
  // auto-distributed and recommended as somebody's next window.
  const base = {
    hasUnit: true,
    typeMatches: true,
    fit: "fits" as const,
    condition: "ok" as const,
    atLocationOrLoaded: true,
  };

  it("is incomplete, not blocked, when nobody has checked the specs", () => {
    const r = readyToInstall({ ...base, confirmed: false });
    expect(r.status).toBe("incomplete");
    expect(r.reasons.join(" ")).toContain("Specs not checked");
  });

  it("is ready once somebody has", () => {
    expect(readyToInstall({ ...base, confirmed: true }).status).toBe("ready");
  });

  it("behaves exactly as before when the caller cannot know", () => {
    // Optional on purpose: a partial select must not silently flip every
    // opening on the job to incomplete.
    expect(readyToInstall(base).status).toBe("ready");
  });
});
