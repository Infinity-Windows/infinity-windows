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
  createActivityClock,
  createHiddenClock,
  fetchPublishedVersion,
  isEditingText,
} from "../../lib/pwa/checkForUpdate";
import {
  decideUpdateAction,
  SETTLE_MS,
  VERSION_POLL_INTERVAL_MS,
} from "../../lib/pwa/updateCore";
import { hasUnsavedWork } from "../../lib/pwa/unsavedWork";
import { supabase, supabaseConfigured } from "../../lib/supabase";

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
 *   - Install banner: "Add Forge Windows to your home screen" (native prompt
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
 * And on 2026-09-23, after the owner's own phone sat on an old build through a
 * Refresh while other phones had updated within minutes:
 *
 *   4. Opening the app and signing in are safe moments too, as is the sign-in
 *      screen itself, so a phone catches up right there instead of waiting for
 *      someone to leave and come back. "Getting the newest version" shows while
 *      it downloads, so the reload that follows is expected.
 *   5. "Is an update waiting" is read from the service worker itself, not only
 *      from the banner's flag. Dismissing the banner used to clear the only
 *      record of the waiting worker, and nothing brought it back until the app
 *      was fully closed — on an iPhone that can be days.
 *   6. The first check waits for the service worker registration instead of
 *      silently doing nothing when it runs before registration finishes, which
 *      cost some phones five minutes and others nothing.
 *
 * The safety rule lives in updateCore.ts, with the reasoning about why an
 * installer's in-memory capture outranks being up to date.
 */
function PwaUpdateBanner() {
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const hiddenClock = useRef(createHiddenClock());
  const activity = useRef(createActivityClock());
  // null until auth has answered; updateCore reads null as "signed in".
  const signedIn = useRef<boolean | null>(null);
  // Applying an update reloads the page, so re-entering that path while it is
  // already under way would only fight itself.
  const applying = useRef(false);
  // A dismissed banner stays away until the app next comes back into view —
  // but the waiting update itself is never forgotten.
  const dismissedUntilReturn = useRef(false);
  const deferTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shown, setShown] = useState<"none" | "downloading" | "ready" | "applying">("none");

  const {
    needRefresh: [needRefresh],
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
  // The latest decision cycle, for listeners that outlive one effect run.
  const evaluateRef = useRef<(returning: boolean) => Promise<void>>(async () => {});

  const applyNow = useCallback(() => {
    applying.current = true;
    setShown("applying");
    // `true` posts SKIP_WAITING and reloads. A bare location.reload() would
    // NOT help: the old worker still controls the page and would serve the
    // same cached shell straight back.
    void apply.current(true);
    // If the takeover never happens, say so instead of "Updating…" forever.
    setTimeout(() => {
      applying.current = false;
      setShown("ready");
    }, 10_000);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const currentRegistration = async () => {
      if (registration.current) return registration.current;
      try {
        const reg = (await navigator.serviceWorker?.getRegistration()) ?? null;
        if (reg) registration.current = reg;
        return reg;
      } catch {
        return null;
      }
    };

    /**
     * One decision cycle. `returning` is true when triggered by the app coming
     * back into view, which is the only case allowed to consume the hidden
     * duration.
     */
    const evaluate = async (returning: boolean) => {
      if (cancelled || applying.current) return;
      const hiddenForMs = returning ? hiddenClock.current.takeHiddenDuration() : null;

      const published = await fetchPublishedVersion();
      if (cancelled) return;
      const reg = await currentRegistration();
      if (cancelled) return;

      const action = decideUpdateAction({
        runningBuildId: BUILD_ID,
        latestBuildId: published?.buildId ?? null,
        swUpdateWaiting: needRefresh || Boolean(reg?.waiting),
        hasUnsavedWork: hasUnsavedWork(),
        hiddenForMs,
        signedIn: signedIn.current,
        ...activity.current.read(),
        typing: isEditingText(document.activeElement),
      });

      if (action === "check") {
        if (!reg) return;
        setShown((s) => (s === "none" ? "downloading" : s));
        try {
          await reg.update();
        } catch {
          // Offline or the fetch failed: the next check tries again.
        }
        if (cancelled) return;
        const installing = reg.installing;
        if (!installing) {
          // Nothing new was found (yet) — do not claim a download is running.
          if (!reg.waiting) setShown((s) => (s === "downloading" ? "none" : s));
          return;
        }
        // Downloads the new worker; when it finishes, needRefresh flips and
        // this runs again with something to apply.
        installing.addEventListener("statechange", () => {
          if (installing.state === "redundant") {
            setShown((s) => (s === "downloading" ? "none" : s));
          }
          if (installing.state === "installed") void evaluateRef.current(false);
        });
        return;
      }
      if (action === "reload") {
        applyNow();
        return;
      }
      if (action === "defer") {
        if (deferTimer.current) clearTimeout(deferTimer.current);
        deferTimer.current = setTimeout(() => void evaluateRef.current(false), SETTLE_MS);
        setShown((s) => (s === "downloading" || s === "none" ? "ready" : s));
        return;
      }
      if (action === "prompt") {
        setShown(dismissedUntilReturn.current ? "none" : "ready");
        return;
      }
      setShown("none");
    };
    evaluateRef.current = evaluate;

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenClock.current.markHidden();
        return;
      }
      dismissedUntilReturn.current = false;
      void evaluate(true);
    };

    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(() => void evaluate(false), VERSION_POLL_INTERVAL_MS);
    void evaluate(false);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
      if (deferTimer.current) clearTimeout(deferTimer.current);
    };
  }, [needRefresh, applyNow]);

  // Signing in starts a fresh moment; the sign-in screen is one throughout.
  useEffect(() => {
    if (!supabaseConfigured) return;
    let previous: string | null | undefined;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const userId = session?.user?.id ?? null;
      signedIn.current = userId !== null;
      if (previous !== undefined && userId !== null && userId !== previous) {
        activity.current.markFresh();
      }
      const changed = userId !== previous;
      previous = userId;
      if (changed) void evaluateRef.current(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  // Taps and typing, so a reload never lands mid-action.
  useEffect(() => {
    const interact = () => activity.current.noteInteraction();
    const typed = () => activity.current.noteTyped();
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", interact, opts);
    window.addEventListener("keydown", interact, opts);
    window.addEventListener("input", typed, opts);
    return () => {
      window.removeEventListener("pointerdown", interact, opts);
      window.removeEventListener("keydown", interact, opts);
      window.removeEventListener("input", typed, opts);
    };
  }, []);

  if (shown === "none") return null;

  if (shown === "downloading" || shown === "applying") {
    return (
      <div className="pwa-banner pwa-banner-update" role="status" aria-live="polite">
        <span className="pwa-banner-icon" aria-hidden>
          <RefreshCw size={18} />
        </span>
        <div className="pwa-banner-text">
          <strong>
            {shown === "applying"
              ? "Updating Forge Windows…"
              : "Getting the newest version…"}
          </strong>
          <span>
            {shown === "applying"
              ? "One moment."
              : "Keep working — it switches over when nothing is in progress."}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="pwa-banner pwa-banner-update" role="alert" aria-live="polite">
      <span className="pwa-banner-icon" aria-hidden>
        <RefreshCw size={18} />
      </span>
      <div className="pwa-banner-text">
        <strong>A new version is available</strong>
        <span>Refresh to get the latest Forge Windows.</span>
      </div>
      <button
        type="button"
        className="wizard-btn primary pwa-banner-action"
        onClick={applyNow}
      >
        Refresh
      </button>
      <button
        type="button"
        className="pwa-banner-close"
        aria-label="Dismiss update notice"
        onClick={() => {
          dismissedUntilReturn.current = true;
          setShown("none");
        }}
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
      aria-label="Add Forge Windows to your home screen"
    >
      <div className="pwa-banner-row">
        <span className="pwa-banner-icon" aria-hidden>
          <Download size={18} />
        </span>
        <div className="pwa-banner-text">
          <strong>Add Forge Windows to your home screen</strong>
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
              Tap <strong>Add</strong>, then open Forge Windows from your home screen.
            </span>
          </li>
        </ol>
      )}
    </div>
  );
}
