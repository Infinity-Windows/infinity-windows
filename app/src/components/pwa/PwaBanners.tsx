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
import { BUILD_ID } from "../../lib/pwa/buildInfo";
import {
  createHiddenClock,
  fetchPublishedVersion,
} from "../../lib/pwa/checkForUpdate";
import {
  decideUpdateAction,
  VERSION_POLL_INTERVAL_MS,
} from "../../lib/pwa/updateCore";
import { hasUnsavedWork } from "../../lib/pwa/unsavedWork";

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

/**
 * Update surface.
 *
 * The old behaviour was a single `registration.update()` on an hour-long timer.
 * That timer does not tick while a PWA is backgrounded, which on a job site is
 * most of the day, so a phone could stay a whole shift behind master — and a
 * collaborator once sat on an old build for hours. Three things changed:
 *
 *   1. version.json is polled, and checked again the moment the app comes back
 *      into view, so returning to the app is enough to notice a new build.
 *   2. Noticing triggers the service-worker check that produces the waiting
 *      worker, instead of waiting for the top of the hour.
 *   3. When it is provably safe — nothing unsaved, and the app has been out of
 *      sight long enough that nobody is mid-tap — it applies the update itself
 *      rather than asking. Otherwise it asks, exactly as before.
 *
 * The safety rule lives in updateCore.ts, with the reasoning about why an
 * installer's in-memory capture outranks being up to date.
 */
function PwaUpdateBanner() {
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const hiddenClock = useRef(createHiddenClock());
  // Applying an update reloads the page, so re-entering that path while it is
  // already under way would only fight itself.
  const applying = useRef(false);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, reg) {
      registration.current = reg ?? null;
    },
  });

  // Held in a ref so the effect below does not re-subscribe on every render
  // just because the helper is a fresh closure each time.
  const apply = useRef(updateServiceWorker);
  apply.current = updateServiceWorker;

  useEffect(() => {
    let cancelled = false;

    /**
     * One decision cycle. `returning` is true when triggered by the app coming
     * back into view, which is the only case allowed to consume the hidden
     * duration and therefore the only case that can auto-apply.
     */
    const evaluate = async (returning: boolean) => {
      if (cancelled || applying.current) return;

      const published = await fetchPublishedVersion();
      if (cancelled) return;

      const action = decideUpdateAction({
        runningBuildId: BUILD_ID,
        latestBuildId: published?.buildId ?? null,
        swUpdateWaiting: needRefresh,
        hasUnsavedWork: hasUnsavedWork(),
        hiddenForMs: returning ? hiddenClock.current.takeHiddenDuration() : null,
      });

      if (action === "check") {
        // Downloads the new worker; when it finishes, needRefresh flips and
        // this runs again with something to apply.
        await registration.current?.update();
        return;
      }
      if (action === "reload") {
        applying.current = true;
        // `true` posts SKIP_WAITING and reloads. A bare location.reload() would
        // NOT help: the old worker still controls the page and would serve the
        // same cached shell straight back.
        void apply.current(true);
      }
      // "prompt" needs nothing here — needRefresh already renders the banner.
      // "none" likewise.
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenClock.current.markHidden();
        return;
      }
      void evaluate(true);
    };

    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(() => void evaluate(false), VERSION_POLL_INTERVAL_MS);
    void evaluate(false);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
    };
  }, [needRefresh]);

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
