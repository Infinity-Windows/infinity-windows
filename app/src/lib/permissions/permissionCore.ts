// Pure, framework-free core for the Notifications + Location onboarding wizard
// (p1-10). NO DOM, NO permission APIs, NO React, NO localStorage in this file —
// every function is deterministic so the wizard's gating and the per-permission
// state machine can be proven with plain unit tests and a fake adapter.
//
// The runtime (permissionEnv.ts / usePermissions.ts) wires this core to the real
// Notification / Geolocation / navigator.permissions APIs behind a thin adapter.
//
// settingsView's copy is bilingual (installer-spanish-first-fourteen): it
// takes a plain translate function rather than importing TFn from lib/i18n's
// context.ts, which pulls in React — this file's "NO React" rule stays true
// even though it now speaks two languages. Its own catalog + translate
// imports are pure (no DOM/React either), and `t` defaults to English so the
// existing unit tests below need no changes.

import { CATALOG, type TKey } from "../i18n/catalog";
import { translate, type Lang, type TVars } from "../i18n/translate";

/** A minimal translate-function shape — deliberately NOT TFn from context.ts,
 *  which imports React. */
type T = (key: TKey, vars?: TVars) => string;
const englishT: T = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);

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

const KIND_NOUN: Record<PermissionKind, TKey> = {
  notifications: "permSettings.kind.notifications",
  location: "permSettings.kind.location",
};
const KIND_NOUN_LOWER: Record<PermissionKind, TKey> = {
  notifications: "permSettings.kindLower.notifications",
  location: "permSettings.kindLower.location",
};

/**
 * Derive the Settings UI descriptor for one permission. Pure so the copy and
 * the "can we offer a button?" decision are unit-testable. `t` defaults to
 * English, same as everywhere else in the app a pure module speaks for a
 * screen it has no React access to.
 */
export function settingsView(
  kind: PermissionKind,
  status: PermissionStatus,
  t: T = englishT,
): SettingsView {
  const noun = t(KIND_NOUN[kind]);
  const nounLower = t(KIND_NOUN_LOWER[kind]);
  switch (status) {
    case "granted":
      return {
        label: t("permSettings.on"),
        tone: "ok",
        hint:
          kind === "notifications"
            ? t("permSettings.hint.grantedNotifications")
            : t("permSettings.hint.grantedLocation"),
        canRequest: false,
        needsSiteSettings: false,
      };
    case "denied":
      return {
        label: t("permSettings.blocked"),
        tone: "warn",
        hint: t("permSettings.hint.denied", { noun, nounLower }),
        canRequest: false,
        needsSiteSettings: true,
      };
    case "prompt":
    case "dismissed":
      return {
        label: t("permSettings.off"),
        tone: "info",
        hint:
          kind === "notifications"
            ? t("permSettings.hint.offNotifications")
            : t("permSettings.hint.offLocation"),
        canRequest: true,
        needsSiteSettings: false,
      };
    case "unsupported":
      return {
        label: t("permSettings.notSupported"),
        tone: "muted",
        hint: t("permSettings.hint.unsupported", { nounLower }),
        canRequest: false,
        needsSiteSettings: false,
      };
    case "insecure-context":
      return {
        label: t("permSettings.unavailable"),
        tone: "muted",
        hint: t("permSettings.hint.insecure", { noun }),
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
