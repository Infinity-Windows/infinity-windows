import { useCallback, useEffect, useRef, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { Download, Plus, RefreshCw, Share, X } from "lucide-react";
import {
  decideInstallPrompt,
  gatherInstallFacts,
  readInstallDismissedAt,
  writeInstallDismissedAt,
  type InstallPromptMode,
} from "../../lib/pwa/installCore";

/** How often to poll for a new deployed service worker (once an hour). */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The Chromium-only `beforeinstallprompt` event. Not in the DOM lib, so we
 * declare the minimal shape we use.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * PWA install + update surfaces (p1-18). Rendered once, high in the tree, so it
 * works on every screen regardless of auth/route:
 *   - Install banner: "Add Infinity Windows to your home screen" (native prompt
 *     on Android/desktop Chromium; step-by-step Share → Add to Home Screen on
 *     iOS Safari, which never fires beforeinstallprompt). Installing is what
 *     unlocks iOS web-push notifications.
 *   - Update banner: "A new version is available — Refresh" when a new service
 *     worker is waiting.
 * Nothing renders when already installed (standalone).
 */
export function PwaBanners() {
  return (
    <>
      <PwaUpdateBanner />
      <PwaInstallBanner />
    </>
  );
}

function PwaUpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      // Periodically ask the browser to check for a new deploy so the banner
      // can appear without a manual reload during a long shift.
      if (registration) {
        setInterval(() => {
          void registration.update();
        }, UPDATE_CHECK_INTERVAL_MS);
      }
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="pwa-banner pwa-banner-update" role="alert" aria-live="polite">
      <span className="pwa-banner-icon" aria-hidden>
        <RefreshCw size={18} />
      </span>
      <div className="pwa-banner-text">
        <strong>A new version is available</strong>
        <span>Refresh to get the latest Infinity Windows.</span>
      </div>
      <button
        type="button"
        className="wizard-btn primary pwa-banner-action"
        onClick={() => void updateServiceWorker(true)}
      >
        Refresh
      </button>
      <button
        type="button"
        className="pwa-banner-close"
        aria-label="Dismiss update notice"
        onClick={() => setNeedRefresh(false)}
      >
        <X size={18} aria-hidden />
      </button>
    </div>
  );
}

function PwaInstallBanner() {
  const [mode, setMode] = useState<InstallPromptMode>("none");
  const [showIosSteps, setShowIosSteps] = useState(false);
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);

  const recompute = useCallback(() => {
    setMode(
      decideInstallPrompt({
        ...gatherInstallFacts(),
        canPromptNatively: deferredPrompt.current != null,
        dismissedAt: readInstallDismissedAt(),
        now: Date.now(),
      }),
    );
  }, []);

  useEffect(() => {
    recompute();

    const onBeforeInstallPrompt = (event: Event) => {
      // Suppress Chrome's default mini-infobar; we drive the prompt ourselves.
      event.preventDefault();
      deferredPrompt.current = event as BeforeInstallPromptEvent;
      recompute();
    };
    const onAppInstalled = () => {
      deferredPrompt.current = null;
      writeInstallDismissedAt(Date.now());
      setMode("none");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, [recompute]);

  if (mode === "none") return null;

  const dismiss = () => {
    writeInstallDismissedAt(Date.now());
    setShowIosSteps(false);
    setMode("none");
  };

  const installNatively = async () => {
    const event = deferredPrompt.current;
    if (!event) return;
    await event.prompt();
    try {
      await event.userChoice;
    } catch {
      // The choice promise can reject if the prompt is dismissed abnormally.
    }
    // A beforeinstallprompt event can only be used once.
    deferredPrompt.current = null;
    setMode("none");
  };

  return (
    <div
      className="pwa-banner pwa-banner-install"
      role="dialog"
      aria-label="Add Infinity Windows to your home screen"
    >
      <div className="pwa-banner-row">
        <span className="pwa-banner-icon" aria-hidden>
          <Download size={18} />
        </span>
        <div className="pwa-banner-text">
          <strong>Add Infinity Windows to your home screen</strong>
          <span>
            {mode === "ios"
              ? "Install it to launch like an app — and to receive notifications on your iPhone."
              : "Install it to launch like an app and get notifications."}
          </span>
        </div>
        {mode === "native" ? (
          <button
            type="button"
            className="wizard-btn primary pwa-banner-action"
            onClick={() => void installNatively()}
          >
            Install
          </button>
        ) : (
          <button
            type="button"
            className="wizard-btn primary pwa-banner-action"
            aria-expanded={showIosSteps}
            onClick={() => setShowIosSteps((open) => !open)}
          >
            How to
          </button>
        )}
        <button
          type="button"
          className="pwa-banner-close"
          aria-label="Dismiss install prompt"
          onClick={dismiss}
        >
          <X size={18} aria-hidden />
        </button>
      </div>

      {mode === "ios" && showIosSteps && (
        <ol className="pwa-ios-steps">
          <li>
            <span className="pwa-ios-step-icon" aria-hidden>
              <Share size={16} />
            </span>
            <span>
              Tap the <strong>Share</strong> icon in Safari's toolbar.
            </span>
          </li>
          <li>
            <span className="pwa-ios-step-icon" aria-hidden>
              <Plus size={16} />
            </span>
            <span>
              Choose <strong>Add to Home Screen</strong>.
            </span>
          </li>
          <li>
            <span className="pwa-ios-step-icon" aria-hidden>
              <Download size={16} />
            </span>
            <span>
              Tap <strong>Add</strong>, then open Infinity from your home screen.
            </span>
          </li>
        </ol>
      )}
    </div>
  );
}
