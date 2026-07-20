// Pure, framework-free core for the Notifications + Location onboarding wizard
// (p1-10). NO DOM, NO permission APIs, NO React, NO localStorage in this file —
// every function is deterministic so the wizard's gating and the per-permission
// state machine can be proven with plain unit tests and a fake adapter.
//
// The runtime (permissionEnv.ts / usePermissions.ts) wires this core to the real
// Notification / Geolocation / navigator.permissions APIs behind a thin adapter.

/** The two permissions this wizard primes. */
export type PermissionKind = "notifications" | "location";

/**
 * Per-permission status the app cares about.
 * - unsupported       — the browser has no such API.
 * - insecure-context  — http (non-localhost); the API is unavailable/blocked.
 * - prompt            — supported & askable; the OS prompt has not resolved.
 * - granted           — the user allowed it.
 * - denied            — HARD denied; JS can no longer re-prompt (site settings).
 * - dismissed         — the user waved off the OS prompt without deciding; we
 *                       may ask again later.
 */
export type PermissionStatus =
  | "unsupported"
  | "insecure-context"
  | "prompt"
  | "granted"
  | "denied"
  | "dismissed";

/** The user's persisted choice about the wizard itself (localStorage). */
export type WizardChoice = "pending" | "completed" | "not-now";

/** Ordered wizard steps. */
export type WizardStep = "welcome" | "notifications" | "location" | "done";

export const WIZARD_STEPS: readonly WizardStep[] = [
  "welcome",
  "notifications",
  "location",
  "done",
] as const;

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

/** The step after `step`, or null if it's the last one. */
export function nextStep(step: WizardStep): WizardStep | null {
  const i = stepIndex(step);
  return i >= 0 && i < WIZARD_STEPS.length - 1 ? WIZARD_STEPS[i + 1] : null;
}

/** The step before `step`, or null if it's the first one. */
export function prevStep(step: WizardStep): WizardStep | null {
  const i = stepIndex(step);
  return i > 0 ? WIZARD_STEPS[i - 1] : null;
}

/**
 * Can we still meaningfully ask for this permission? Only `prompt` / `dismissed`
 * are actionable — granted needs nothing, and unsupported / insecure / denied
 * can't be changed from JS.
 */
export function isActionable(status: PermissionStatus): boolean {
  return status === "prompt" || status === "dismissed";
}

/** A hard denial: the OS prompt is off the table until the user edits settings. */
export function isHardDenied(status: PermissionStatus): boolean {
  return status === "denied";
}

export interface PermissionSnapshot {
  wizardChoice: WizardChoice;
  notifications: PermissionStatus;
  location: PermissionStatus;
}

/**
 * Should the wizard auto-open on this load? Only on a truly first run
 * (`pending` — never completed, never "not now") AND only when there is at least
 * one permission we can still act on. If everything is already decided
 * (granted/denied) or impossible (unsupported/insecure), we stay quiet rather
 * than opening a wizard with nothing to do.
 */
export function shouldAutoOpenWizard(snap: PermissionSnapshot): boolean {
  if (snap.wizardChoice !== "pending") return false;
  return isActionable(snap.notifications) || isActionable(snap.location);
}

// --- API result → status mapping -----------------------------------------

/** Map a live `Notification.permission` reading into our status. */
export function mapNotificationPermission(
  perm: NotificationPermission | null | undefined,
): PermissionStatus {
  if (perm === "granted") return "granted";
  if (perm === "denied") return "denied";
  return "prompt"; // "default" or unknown → still askable
}

/**
 * Map the result of `Notification.requestPermission()`. Unlike a passive read,
 * "default" here means the user dismissed the OS prompt without choosing — we
 * record that as `dismissed` so we can offer it again rather than treating it as
 * a hard denial.
 */
export function mapNotificationRequest(
  result: NotificationPermission,
): PermissionStatus {
  if (result === "granted") return "granted";
  if (result === "denied") return "denied";
  return "dismissed";
}

/** Map a live `navigator.permissions.query` state for geolocation. */
export function mapPermissionState(
  state: PermissionState | null | undefined,
): PermissionStatus {
  if (state === "granted") return "granted";
  if (state === "denied") return "denied";
  if (state === "prompt") return "prompt";
  return "prompt"; // null/unknown (Safari) → assume askable
}

/** Outcome of a geolocation priming call. */
export type GeoResult = "granted" | "denied" | "unavailable";

/** Map a geolocation priming result into our status. */
export function mapGeoResult(result: GeoResult): PermissionStatus {
  if (result === "granted") return "granted";
  if (result === "denied") return "denied";
  return "dismissed"; // timeout / position-unavailable → can try again
}

// --- Settings presentation ------------------------------------------------

export type StatusTone = "ok" | "warn" | "info" | "muted";

export interface SettingsView {
  /** Short status label, e.g. "On" / "Blocked". */
  label: string;
  tone: StatusTone;
  /** One-line explanation / next-step guidance. */
  hint: string;
  /** Whether a "Turn on" / "Enable" button should be offered. */
  canRequest: boolean;
  /** True when the only fix is the browser's site settings (hard denied). */
  needsSiteSettings: boolean;
}

const KIND_NOUN: Record<PermissionKind, string> = {
  notifications: "Notifications",
  location: "Location",
};

/**
 * Derive the Settings UI descriptor for one permission. Pure so the copy and
 * the "can we offer a button?" decision are unit-testable.
 */
export function settingsView(
  kind: PermissionKind,
  status: PermissionStatus,
): SettingsView {
  const noun = KIND_NOUN[kind];
  switch (status) {
    case "granted":
      return {
        label: "On",
        tone: "ok",
        hint:
          kind === "notifications"
            ? "You'll get alerts for the things that need you."
            : "Clock-ins and on-site reminders can use your location.",
        canRequest: false,
        needsSiteSettings: false,
      };
    case "denied":
      return {
        label: "Blocked",
        tone: "warn",
        hint: `${noun} are blocked for this site. To turn them back on, open your browser's site settings for this page and allow ${noun.toLowerCase()}, then reload.`,
        canRequest: false,
        needsSiteSettings: true,
      };
    case "prompt":
    case "dismissed":
      return {
        label: "Off",
        tone: "info",
        hint:
          kind === "notifications"
            ? "Turn on to get alerted for schedule changes, timecard approvals, and today's toolbox talk."
            : "Turn on for accurate clock-in/out stamps and on-site reminders.",
        canRequest: true,
        needsSiteSettings: false,
      };
    case "unsupported":
      return {
        label: "Not supported",
        tone: "muted",
        hint: `This device or browser doesn't support ${noun.toLowerCase()}.`,
        canRequest: false,
        needsSiteSettings: false,
      };
    case "insecure-context":
      return {
        label: "Unavailable",
        tone: "muted",
        hint: `${noun} need a secure (https) connection. They'll be available once the app is served over https.`,
        canRequest: false,
        needsSiteSettings: false,
      };
  }
}

/** One-line summary of what ended up enabled, for the wizard's Done step. */
export function summarizeEnabled(
  notifications: PermissionStatus,
  location: PermissionStatus,
): string {
  const on: string[] = [];
  if (notifications === "granted") on.push("notifications");
  if (location === "granted") on.push("location");
  if (on.length === 0) {
    return "No problem — you can turn these on any time in Settings.";
  }
  if (on.length === 1) {
    return `${on[0] === "notifications" ? "Notifications" : "Location"} are on. You can change this any time in Settings.`;
  }
  return "Notifications and location are on. You can change this any time in Settings.";
}
