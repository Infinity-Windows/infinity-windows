// The pure rules behind data vs tracking jobs (standard-tracking-jobs slice 2).
// These are the ones ProjectDetail and the route guards trust, so the tab and
// route decisions are pinned here rather than only through a heavy render.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODES,
  allowsData,
  allowsTracking,
  effectiveClockInMode,
  hubTabsFor,
  isTrackingOnly,
  modeBadgeKey,
  normalizeModes,
  promotedModes,
  resolveHubTab,
  validateModes,
  type HubTabId,
} from "./jobModes";

describe("normalizeModes — an unknown or empty job reads as data-only", () => {
  it("defaults absent / empty / all-unknown to data", () => {
    expect(normalizeModes(undefined)).toEqual(["data"]);
    expect(normalizeModes(null)).toEqual(["data"]);
    expect(normalizeModes([])).toEqual(["data"]);
    expect(normalizeModes(["bogus"])).toEqual(["data"]);
    // The backfill promise: every existing row is data-only.
    expect(DEFAULT_MODES).toEqual(["data"]);
  });

  it("keeps known modes, de-duplicated, in a stable data-then-tracking order", () => {
    expect(normalizeModes(["tracking"])).toEqual(["tracking"]);
    expect(normalizeModes(["tracking", "data"])).toEqual(["data", "tracking"]);
    expect(normalizeModes(["data", "data"])).toEqual(["data"]);
    expect(normalizeModes(["data", "tracking", "bogus"])).toEqual(["data", "tracking"]);
  });
});

describe("validateModes — the create-form / RPC mirror", () => {
  it("returns a clean subset, or null when nothing usable was sent", () => {
    expect(validateModes(undefined)).toBeNull();
    expect(validateModes([])).toBeNull();
    expect(validateModes(["nope"])).toBeNull();
    expect(validateModes(["data"])).toEqual(["data"]);
    expect(validateModes(["tracking", "data"])).toEqual(["data", "tracking"]);
  });
});

describe("mode predicates", () => {
  it("allowsData / allowsTracking", () => {
    expect(allowsData(["data"])).toBe(true);
    expect(allowsData(["tracking"])).toBe(false);
    expect(allowsData(undefined)).toBe(true); // unknown → data
    expect(allowsTracking(["tracking"])).toBe(true);
    expect(allowsTracking(["data", "tracking"])).toBe(true);
    expect(allowsTracking(["data"])).toBe(false);
  });

  it("isTrackingOnly is true ONLY when tracking is allowed and data is not", () => {
    expect(isTrackingOnly(["tracking"])).toBe(true);
    expect(isTrackingOnly(["data"])).toBe(false);
    expect(isTrackingOnly(["data", "tracking"])).toBe(false);
    expect(isTrackingOnly(undefined)).toBe(false); // unknown job is not tracking-only
  });
});

describe("effectiveClockInMode — what the shift records", () => {
  it("uses the pick for a both-mode job", () => {
    expect(effectiveClockInMode(["data", "tracking"], "tracking")).toBe("tracking");
    expect(effectiveClockInMode(["data", "tracking"], "data")).toBe("data");
    expect(effectiveClockInMode(["data", "tracking"], null)).toBeNull();
  });

  it("uses the one mode silently for a single-mode job", () => {
    expect(effectiveClockInMode(["data"], "tracking")).toBe("data");
    expect(effectiveClockInMode(["tracking"], "data")).toBe("tracking");
  });

  it("records nothing for a job it can't read a mode for", () => {
    expect(effectiveClockInMode(undefined, "data")).toBeNull();
    expect(effectiveClockInMode([], "data")).toBeNull();
    expect(effectiveClockInMode(["bogus"], "data")).toBeNull();
  });
});

describe("modeBadgeKey", () => {
  it("names the badge string for each combination", () => {
    expect(modeBadgeKey(["data"])).toBe("jobmode.badge.data");
    expect(modeBadgeKey(["tracking"])).toBe("jobmode.badge.tracking");
    expect(modeBadgeKey(["data", "tracking"])).toBe("jobmode.badge.both");
    expect(modeBadgeKey(undefined)).toBe("jobmode.badge.data");
  });
});

describe("hubTabsFor — a data job is unchanged, a tracking job is lighter", () => {
  it("a DATA job's tabs are exactly what they were before this feature", () => {
    expect(
      hubTabsFor({ trackingOnly: false, isLead: true, warehouseStaged: false }),
    ).toEqual<HubTabId[]>([
      "overview",
      "dispatch",
      "logs",
      "warehouse",
      "chat",
      "photos",
      "maps-interactive",
      "exceptions",
      "brain",
    ]);
    expect(
      hubTabsFor({ trackingOnly: false, isLead: false, warehouseStaged: false }),
    ).toEqual<HubTabId[]>([
      "overview",
      "warehouse",
      "chat",
      "photos",
      "maps-interactive",
      "brain",
    ]);
  });

  it("a TRACKING job shows the lighter set and warehouse only when staged", () => {
    expect(
      hubTabsFor({ trackingOnly: true, isLead: true, warehouseStaged: true }),
    ).toEqual<HubTabId[]>([
      "overview",
      "specs",
      "logs",
      "photos",
      "chat",
      "time",
      "warehouse",
    ]);
    expect(
      hubTabsFor({ trackingOnly: true, isLead: false, warehouseStaged: false }),
    ).toEqual<HubTabId[]>(["overview", "specs", "photos", "chat", "time"]);
  });

  it("a TRACKING job never shows the data-heavy tabs", () => {
    const tabs = hubTabsFor({ trackingOnly: true, isLead: true, warehouseStaged: true });
    for (const hidden of ["maps-interactive", "dispatch", "brain", "exceptions", "map", "model-studio"]) {
      expect(tabs).not.toContain(hidden);
    }
  });
});

describe("resolveHubTab — the choke point the URL guards share", () => {
  it("a DATA job keeps its acceptance list, including legacy map / model-studio", () => {
    const data = { trackingOnly: false, isLead: true, warehouseStaged: false };
    expect(resolveHubTab("maps-interactive", data)).toBe("maps-interactive");
    expect(resolveHubTab("map", data)).toBe("map");
    expect(resolveHubTab("model-studio", data)).toBe("model-studio");
    expect(resolveHubTab("dispatch", data)).toBe("dispatch");
    expect(resolveHubTab("bogus", data)).toBe("overview");
    expect(resolveHubTab(null, data)).toBe("overview");
  });

  it("a non-lead can't reach a lead-only tab by URL", () => {
    const data = { trackingOnly: false, isLead: false, warehouseStaged: false };
    expect(resolveHubTab("dispatch", data)).toBe("overview");
    expect(resolveHubTab("exceptions", data)).toBe("overview");
    expect(resolveHubTab("maps-interactive", data)).toBe("maps-interactive");
  });

  it("a TRACKING job sends every hidden or legacy tab to overview", () => {
    const trk = { trackingOnly: true, isLead: true, warehouseStaged: false };
    expect(resolveHubTab("maps-interactive", trk)).toBe("overview");
    expect(resolveHubTab("map", trk)).toBe("overview");
    expect(resolveHubTab("model-studio", trk)).toBe("overview");
    expect(resolveHubTab("brain", trk)).toBe("overview");
    expect(resolveHubTab("dispatch", trk)).toBe("overview");
    // Its own tabs pass.
    expect(resolveHubTab("time", trk)).toBe("time");
    expect(resolveHubTab("specs", trk)).toBe("specs");
    expect(resolveHubTab("photos", trk)).toBe("photos");
    // Warehouse only when staged.
    expect(resolveHubTab("warehouse", trk)).toBe("overview");
    expect(
      resolveHubTab("warehouse", { ...trk, warehouseStaged: true }),
    ).toBe("warehouse");
  });
});

// The one-way upgrade (standard-tracking-jobs slice 6). promotedModes is the
// pure mirror of the promote_project_to_data RPC's union, so the tab/route
// consequences of "Build this out" are pinned here rather than only in the DB.
describe("promotedModes — Build this out ADDS data and never removes a mode", () => {
  it("adds data to a tracking-only job (it becomes data+tracking)", () => {
    expect(promotedModes(["tracking"])).toEqual(["data", "tracking"]);
  });

  it("is a no-op for a job that already allows data", () => {
    expect(promotedModes(["data"])).toEqual(["data"]);
    expect(promotedModes(["data", "tracking"])).toEqual(["data", "tracking"]);
    // Idempotent: promoting a promoted tracking job lands on the same set.
    expect(promotedModes(promotedModes(["tracking"]))).toEqual(["data", "tracking"]);
  });

  it("degrades a garbled or empty job to data-only, matching the SQL coalesce", () => {
    expect(promotedModes(undefined)).toEqual(["data"]);
    expect(promotedModes(null)).toEqual(["data"]);
    expect(promotedModes([])).toEqual(["data"]);
    expect(promotedModes(["bogus"])).toEqual(["data"]);
  });

  it("ALWAYS yields data and never a tracking-only set — the change is one-way", () => {
    for (const input of [["tracking"], ["data"], ["data", "tracking"], [], ["bogus"]]) {
      const out = promotedModes(input);
      expect(out).toContain("data"); // data is only ever added
      expect(isTrackingOnly(out)).toBe(false); // so it can never downgrade
    }
  });

  it("keeps every mode the job already had — nothing is dropped", () => {
    // A both-mode job keeps tracking; promotion is a superset of the known input.
    const before = new Set(normalizeModes(["data", "tracking"]));
    for (const m of before) expect(promotedModes(["data", "tracking"])).toContain(m);
  });
});

describe("a promoted job flips onto the full data tab set and routes", () => {
  // After "Build this out", a job that WAS tracking-only reads as data.
  const promoted = promotedModes(["tracking"]); // ["data","tracking"]

  it("no longer reads as tracking-only", () => {
    expect(isTrackingOnly(promoted)).toBe(false);
  });

  it("shows the data-heavy tabs it was hiding", () => {
    const trackingOnly = isTrackingOnly(promoted);
    const tabs = hubTabsFor({ trackingOnly, isLead: true, warehouseStaged: false });
    for (const shown of ["dispatch", "maps-interactive", "brain", "exceptions"]) {
      expect(tabs).toContain(shown as HubTabId);
    }
  });

  it("its URL guards now accept the map, the studio and dispatch", () => {
    // RequireDataJob keys off isTrackingOnly: false → the data routes
    // (/opening, /flash-run, /studio, /model) render instead of redirecting.
    expect(isTrackingOnly(promoted)).toBe(false);
    const opts = { trackingOnly: isTrackingOnly(promoted), isLead: true, warehouseStaged: false };
    expect(resolveHubTab("maps-interactive", opts)).toBe("maps-interactive");
    expect(resolveHubTab("map", opts)).toBe("map");
    expect(resolveHubTab("model-studio", opts)).toBe("model-studio");
    expect(resolveHubTab("dispatch", opts)).toBe("dispatch");
  });
});

describe("nothing logged is lost — the surfaces that show a job's work survive", () => {
  // Promotion only ADDS data; the tabs that render project-scoped logged work
  // (photos, chat, and — for a lead — the daily log) are in BOTH the tracking
  // and the data tab set, so none of them vanish when a job is built out. The
  // records themselves are keyed by project_id, never by mode (verified in the
  // client wrapper test), so the mode flip cannot touch them.
  const trk = { trackingOnly: true, isLead: true, warehouseStaged: false };
  const data = { trackingOnly: false, isLead: true, warehouseStaged: false };

  it("photos, chat and the daily log appear before AND after promotion", () => {
    for (const shared of ["photos", "chat", "logs"] as HubTabId[]) {
      expect(hubTabsFor(trk)).toContain(shared);
      expect(hubTabsFor(data)).toContain(shared);
    }
  });
});
