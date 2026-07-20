import { describe, expect, it } from "vitest";
import {
  isActionable,
  isHardDenied,
  mapGeoResult,
  mapNotificationPermission,
  mapNotificationRequest,
  mapPermissionState,
  nextStep,
  prevStep,
  settingsView,
  shouldAutoOpenWizard,
  stepIndex,
  summarizeEnabled,
  WIZARD_STEPS,
  type PermissionSnapshot,
  type PermissionStatus,
} from "./permissionCore";

const snap = (over: Partial<PermissionSnapshot> = {}): PermissionSnapshot => ({
  wizardChoice: "pending",
  notifications: "prompt",
  location: "prompt",
  ...over,
});

describe("step gating", () => {
  it("orders the four steps", () => {
    expect(WIZARD_STEPS).toEqual(["welcome", "notifications", "location", "done"]);
    expect(stepIndex("location")).toBe(2);
  });

  it("advances forward and backward, stopping at the ends", () => {
    expect(nextStep("welcome")).toBe("notifications");
    expect(nextStep("done")).toBeNull();
    expect(prevStep("welcome")).toBeNull();
    expect(prevStep("done")).toBe("location");
  });
});

describe("isActionable / isHardDenied", () => {
  it("treats prompt and dismissed as actionable, nothing else", () => {
    expect(isActionable("prompt")).toBe(true);
    expect(isActionable("dismissed")).toBe(true);
    for (const s of ["granted", "denied", "unsupported", "insecure-context"] as PermissionStatus[]) {
      expect(isActionable(s)).toBe(false);
    }
  });

  it("flags only denied as hard-denied", () => {
    expect(isHardDenied("denied")).toBe(true);
    expect(isHardDenied("prompt")).toBe(false);
  });
});

describe("shouldAutoOpenWizard", () => {
  it("opens on first run when at least one permission is askable", () => {
    expect(shouldAutoOpenWizard(snap())).toBe(true);
    expect(
      shouldAutoOpenWizard(snap({ notifications: "granted", location: "prompt" })),
    ).toBe(true);
  });

  it("does NOT auto-open once the user chose 'not now'", () => {
    expect(shouldAutoOpenWizard(snap({ wizardChoice: "not-now" }))).toBe(false);
  });

  it("does NOT auto-open once the wizard was completed", () => {
    expect(shouldAutoOpenWizard(snap({ wizardChoice: "completed" }))).toBe(false);
  });

  it("does NOT auto-open when nothing is actionable", () => {
    expect(
      shouldAutoOpenWizard(snap({ notifications: "granted", location: "granted" })),
    ).toBe(false);
    expect(
      shouldAutoOpenWizard(snap({ notifications: "denied", location: "denied" })),
    ).toBe(false);
    expect(
      shouldAutoOpenWizard(
        snap({ notifications: "unsupported", location: "insecure-context" }),
      ),
    ).toBe(false);
  });
});

describe("API result mapping", () => {
  it("maps a passive Notification.permission read", () => {
    expect(mapNotificationPermission("granted")).toBe("granted");
    expect(mapNotificationPermission("denied")).toBe("denied");
    expect(mapNotificationPermission("default")).toBe("prompt");
    expect(mapNotificationPermission(null)).toBe("prompt");
  });

  it("maps a requestPermission() result (default = dismissed, not denied)", () => {
    expect(mapNotificationRequest("granted")).toBe("granted");
    expect(mapNotificationRequest("denied")).toBe("denied");
    expect(mapNotificationRequest("default")).toBe("dismissed");
  });

  it("maps navigator.permissions state, defaulting unknown to prompt", () => {
    expect(mapPermissionState("granted")).toBe("granted");
    expect(mapPermissionState("denied")).toBe("denied");
    expect(mapPermissionState("prompt")).toBe("prompt");
    expect(mapPermissionState(null)).toBe("prompt");
  });

  it("maps geolocation priming results", () => {
    expect(mapGeoResult("granted")).toBe("granted");
    expect(mapGeoResult("denied")).toBe("denied");
    expect(mapGeoResult("unavailable")).toBe("dismissed");
  });
});

describe("settingsView", () => {
  it("offers a request button only when actionable", () => {
    expect(settingsView("notifications", "prompt").canRequest).toBe(true);
    expect(settingsView("notifications", "dismissed").canRequest).toBe(true);
    expect(settingsView("notifications", "granted").canRequest).toBe(false);
    expect(settingsView("location", "denied").canRequest).toBe(false);
    expect(settingsView("location", "unsupported").canRequest).toBe(false);
  });

  it("flags hard-denied with site-settings guidance", () => {
    const v = settingsView("notifications", "denied");
    expect(v.needsSiteSettings).toBe(true);
    expect(v.tone).toBe("warn");
    expect(v.hint.toLowerCase()).toContain("site settings");
  });

  it("uses calm 'ok' tone once granted", () => {
    expect(settingsView("location", "granted").tone).toBe("ok");
    expect(settingsView("location", "granted").label).toBe("On");
  });

  it("explains insecure-context / unsupported without a button", () => {
    expect(settingsView("location", "insecure-context").canRequest).toBe(false);
    expect(settingsView("notifications", "unsupported").canRequest).toBe(false);
  });
});

describe("summarizeEnabled", () => {
  it("summarizes both, one, or none enabled", () => {
    expect(summarizeEnabled("granted", "granted")).toContain("Notifications and location");
    expect(summarizeEnabled("granted", "prompt")).toContain("Notifications");
    expect(summarizeEnabled("denied", "granted")).toContain("Location");
    expect(summarizeEnabled("denied", "denied")).toContain("any time in Settings");
  });
});
