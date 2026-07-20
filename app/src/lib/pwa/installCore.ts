// Pure, browser-free heart of the "add to home screen" install prompt (p1-18).
//
// The tricky bits — iOS/standalone detection and the "should we even show a
// prompt, and which kind?" decision — live here so they're unit-testable
// without a real window, matchMedia, beforeinstallprompt event, or localStorage.
// The thin browser adapters (fact gathering + dismissal storage) live at the
// bottom and degrade to safe no-ops off the main thread.
//
// This mirrors the same detection contract used by the web-push flow
// (pushCore/pushSubscribe): standalone means the media query OR iOS
// navigator.standalone; iOS covers iPadOS masquerading as macOS.

/** How long a dismissal sticks before we may show the install prompt again. */
export const INSTALL_RE_SHOW_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** localStorage key holding the epoch ms of the last dismissal. */
export const INSTALL_DISMISS_KEY = "infinity:pwa-install-dismissed";

/** Which install prompt (if any) to render. */
export type InstallPromptMode = "none" | "native" | "ios";

/** Environment facts the install decision depends on (all serializable). */
export interface InstallPromptFacts {
  /** Already running as an installed PWA (home screen / standalone). */
  isStandalone: boolean;
  /** iOS/iPadOS Safari — never fires beforeinstallprompt, needs manual steps. */
  isIos: boolean;
  /** A `beforeinstallprompt` event has been captured (Android/desktop Chromium). */
  canPromptNatively: boolean;
  /** Epoch ms of the last dismissal, or null if never dismissed. */
  dismissedAt: number | null;
  /** Current time (epoch ms). */
  now: number;
}

/**
 * Pure decision: which install prompt should we show?
 *   - Never when already installed (standalone).
 *   - Never while a recent dismissal is still in its quiet window.
 *   - "native" when the browser handed us a beforeinstallprompt event.
 *   - "ios" for iOS Safari (which can only add-to-home-screen manually).
 *   - "none" otherwise (e.g. desktop browsers with no install support).
 */
export function decideInstallPrompt(f: InstallPromptFacts): InstallPromptMode {
  if (f.isStandalone) return "none";
  if (
    f.dismissedAt != null &&
    f.now - f.dismissedAt < INSTALL_RE_SHOW_AFTER_MS
  ) {
    return "none";
  }
  if (f.canPromptNatively) return "native";
  if (f.isIos) return "ios";
  return "none";
}

/** Detect iOS/iPadOS Safari, including iPadOS reporting itself as a Mac. */
export function detectIsIos(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  // iPadOS 13+ masquerades as macOS; the touch-point count gives it away.
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

// --- Browser adapters (untested; thin glue over the pure core) --------------

/** Running as an installed PWA (display-mode standalone, or iOS standalone)? */
export function detectIsStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mm = window.matchMedia?.("(display-mode: standalone)")?.matches ?? false;
  const iosStandalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return mm || iosStandalone;
}

/** Gather the live detection facts (iOS + standalone) from the browser. */
export function gatherInstallFacts(): Pick<
  InstallPromptFacts,
  "isStandalone" | "isIos"
> {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const touch =
    typeof navigator !== "undefined" ? navigator.maxTouchPoints ?? 0 : 0;
  return {
    isStandalone: detectIsStandalone(),
    isIos: detectIsIos(ua, touch),
  };
}

/** Read the last-dismissed timestamp; null when never dismissed / unavailable. */
export function readInstallDismissedAt(): number | null {
  try {
    const raw = localStorage.getItem(INSTALL_DISMISS_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Persist a dismissal timestamp so we don't nag again for a while. */
export function writeInstallDismissedAt(at: number): void {
  try {
    localStorage.setItem(INSTALL_DISMISS_KEY, String(at));
  } catch {
    // Storage may be unavailable (private mode); dismissal is best-effort.
  }
}
