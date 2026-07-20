// Thin adapter over the browser's permission surfaces (Notification API,
// Geolocation, navigator.permissions, localStorage) so the pure state machine in
// permissionCore.ts never touches globals directly. Everything that reads or
// mutates the environment lives behind this interface, which means the readers
// below can be exercised in tests with a hand-rolled fake — no jsdom required.

import { primeGeolocation } from "../geo";
import {
  mapGeoResult,
  mapNotificationPermission,
  mapNotificationRequest,
  mapPermissionState,
  type PermissionStatus,
  type WizardChoice,
} from "./permissionCore";

export interface PermissionEnv {
  /** https or localhost — geolocation & notifications require it. */
  isSecureContext(): boolean;

  notificationSupported(): boolean;
  getNotificationPermission(): NotificationPermission | null;
  requestNotificationPermission(): Promise<NotificationPermission>;

  geolocationSupported(): boolean;
  /** Trigger the real OS geolocation prompt once and report the outcome. */
  requestGeolocation(): Promise<"granted" | "denied" | "unavailable">;

  /**
   * Live permission state via navigator.permissions.query, or null when the API
   * is missing/unreliable (Safari, older browsers). Never throws.
   */
  queryPermission(name: string): Promise<PermissionState | null>;

  readWizardChoice(): WizardChoice;
  writeWizardChoice(choice: WizardChoice): void;
}

const WIZARD_CHOICE_KEY = "infinity-perm-wizard-choice";

function readChoice(): WizardChoice {
  try {
    const raw = localStorage.getItem(WIZARD_CHOICE_KEY);
    if (raw === "completed" || raw === "not-now" || raw === "pending") return raw;
  } catch {
    // Storage blocked (private mode) → behave as a fresh (pending) run.
  }
  return "pending";
}

function writeChoice(choice: WizardChoice): void {
  try {
    localStorage.setItem(WIZARD_CHOICE_KEY, choice);
  } catch {
    // Non-fatal — the wizard just won't remember across reloads.
  }
}

/** The real browser adapter used everywhere except tests. */
export const browserPermissionEnv: PermissionEnv = {
  isSecureContext: () =>
    typeof window !== "undefined" ? window.isSecureContext !== false : false,

  notificationSupported: () =>
    typeof window !== "undefined" && "Notification" in window,

  getNotificationPermission: () => {
    if (typeof Notification === "undefined") return null;
    return Notification.permission;
  },

  requestNotificationPermission: () => {
    if (typeof Notification === "undefined") return Promise.resolve("denied");
    try {
      // Some browsers still return void + callback; normalize to a promise.
      const r = Notification.requestPermission();
      return Promise.resolve(r);
    } catch {
      return Promise.resolve("denied");
    }
  },

  geolocationSupported: () =>
    typeof navigator !== "undefined" && "geolocation" in navigator,

  requestGeolocation: () => primeGeolocation(),

  queryPermission: async (name: string) => {
    try {
      if (typeof navigator === "undefined" || !navigator.permissions?.query) {
        return null;
      }
      const status = await navigator.permissions.query({
        name: name as PermissionName,
      });
      return status.state;
    } catch {
      return null;
    }
  },

  readWizardChoice: readChoice,
  writeWizardChoice: writeChoice,
};

/**
 * Read the current notifications status. Secure-context and support gates come
 * first; otherwise we trust Notification.permission (the most reliable signal).
 */
export async function readNotificationStatus(
  env: PermissionEnv,
): Promise<PermissionStatus> {
  if (!env.isSecureContext()) return "insecure-context";
  if (!env.notificationSupported()) return "unsupported";
  return mapNotificationPermission(env.getNotificationPermission());
}

/**
 * Read the current location status. Prefer the live navigator.permissions query
 * (so a change made in site settings is reflected), falling back to "prompt"
 * when the query API is unavailable.
 */
export async function readLocationStatus(
  env: PermissionEnv,
): Promise<PermissionStatus> {
  if (!env.isSecureContext()) return "insecure-context";
  if (!env.geolocationSupported()) return "unsupported";
  const state = await env.queryPermission("geolocation");
  return mapPermissionState(state);
}

/** Fire the real notification prompt (only call after the user opts in). */
export async function requestNotifications(
  env: PermissionEnv,
): Promise<PermissionStatus> {
  if (!env.isSecureContext()) return "insecure-context";
  if (!env.notificationSupported()) return "unsupported";
  const existing = env.getNotificationPermission();
  // Already decided → don't re-fire (denied can't be re-prompted anyway).
  if (existing === "granted") return "granted";
  if (existing === "denied") return "denied";
  const result = await env.requestNotificationPermission();
  return mapNotificationRequest(result);
}

/** Fire the real geolocation prompt (only call after the user opts in). */
export async function requestLocation(
  env: PermissionEnv,
): Promise<PermissionStatus> {
  if (!env.isSecureContext()) return "insecure-context";
  if (!env.geolocationSupported()) return "unsupported";
  const result = await env.requestGeolocation();
  return mapGeoResult(result);
}
