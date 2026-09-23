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
  createVersionCheck,
  isEditingText,
  UPDATE_CHECK_TIMEOUT_MS,
  withDeadline,
} from "../../lib/pwa/checkForUpdate";
import {
  decideUpdateAction,
  HOLD_RECHECK_MS,
  RETURN_CARRY_MS,
  SETTLE_MS,
  VERSION_POLL_INTERVAL_MS,
} from "../../lib/pwa/updateCore";
import { hasUnsavedWork } from "../../lib/pwa/unsavedWork";
import { onSafeSurface, subscribeSafeSurface } from "../../lib/pwa/safeSurface";
import { blocksReload, readQueuedWork, subscribeQueuedWork } from "../../lib/pwa/queuedWork";
import { supabase, supabaseConfigured } from "../../lib/supabase";
import { CATALOG, type TKey } from "../../lib/i18n/catalog";
import { readCachedLang } from "../../lib/i18n/cache";
import { translate } from "../../lib/i18n/translate";

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
 * The update banner's words. It is mounted above LanguageProvider (main.tsx),
 * which only exists once there is a session, so — like the stale-chunk toast
 * in preloadRecovery.ts — it reads the per-device cache the provider writes
 * to. Read at render, not at mount: the banner lives for the whole session
 * and someone may pick Spanish after it mounted.
 */
function useBannerT(): (key: TKey) => string {
  const lang = readCachedLang() ?? "en";
  return useCallback((key: TKey) => translate(CATALOG, lang, key), [lang]);
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
 * An independent review of that change (Codex, 2026-09-23) found three holes,
 * closed here:
 *
 *   7. The opening window counted ANY screen as safe after four quiet seconds,
 *      including one with a voice memo recording — the recorder holds its audio
 *      in memory, claims nothing, and produces no input events. Every surface
 *      that holds bytes only in memory now claims unsaved work, and the two
 *      newer automatic paths (4) additionally require a screen that has
 *      declared itself safe — the sign-in screen or the Work landing with no
 *      sheet open (safeSurface.ts). Nothing on the phone may be mid-send
 *      either (queuedWork.ts); a reload mid-drain can replay a clock punch.
 *   8. A registration that finished AFTER the first check was only stored, so
 *      that phone waited for the five-minute poll — outside the opening window.
 *      Registration finishing now runs the check.
 *   9. Every check awaited version.json before looking at the worker, and that
 *      request had no deadline, so on one bar an update already downloaded and
 *      waiting could be neither applied nor offered. The worker is read first;
 *      the version request is one-at-a-time with a deadline.
 *
 * The safety rule lives in updateCore.ts, with the reasoning about why an
 * installer's in-memory capture outranks being up to date.
 */
function PwaUpdateBanner() {
  const t = useBannerT();
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const hiddenClock = useRef(createHiddenClock());
  const activity = useRef(createActivityClock());
  const versionCheck = useRef(createVersionCheck());
  // null until auth has answered; updateCore reads null as "signed in".
  const signedIn = useRef<boolean | null>(null);
  // The signed-in account, for the queues that are kept per person.
  const userId = useRef<string | null>(null);
  // Applying an update reloads the page, so re-entering that path while it is
  // already under way would only fight itself.
  const applying = useRef(false);
  // A dismissed banner stays away until the app next comes back into view —
  // but the waiting update itself is never forgotten.
  const dismissedUntilReturn = useRef(false);
  // The last decision was "hold": a queue changing is worth another look.
  const holding = useRef(false);
  // A return to the app that queued work held back — see RETURN_CARRY_MS.
  const carriedReturn = useRef<{ hiddenForMs: number; since: number } | null>(null);
  const recheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shown, setShown] = useState<"none" | "downloading" | "waiting" | "ready" | "applying">(
    "none",
  );
  // The latest decision cycle, for callers that outlive one effect run: the
  // registration callback, the installing worker's state change, the timers.
  const evaluateRef = useRef<(returning: boolean) => Promise<void>>(async () => {});

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, reg) {
      registration.current = reg ?? null;
      // The first check may already have run and found no registration. If
      // it did, nothing else would look again until the five-minute poll —
      // long after the opening window has closed.
      if (reg) void evaluateRef.current(false);
    },
  });

  // Held in a ref so the effect below does not re-subscribe on every render
  // just because the helper is a fresh closure each time.
  const apply = useRef(updateServiceWorker);
  apply.current = updateServiceWorker;

  const applyNow = useCallback(() => {
    applying.current = true;
    holding.current = false;
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
    // One decision cycle at a time. A trigger that lands mid-cycle asks for
    // one more cycle afterwards rather than starting a second one over the
    // top: two cycles racing could each read a clean queue and both reload.
    let running = false;
    let again: { returning: boolean } | null = null;
    const check = versionCheck.current;

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

    const clearRecheck = () => {
      if (recheck.current) clearTimeout(recheck.current);
      recheck.current = null;
    };
    const recheckIn = (ms: number) => {
      clearRecheck();
      recheck.current = setTimeout(() => void evaluate(false), ms);
    };

    /**
     * The hidden-duration fact for this cycle. Coming back to the app is the
     * one reading that consumes the clock. A reading that queued work held
     * back may be reused once, briefly, if nobody has touched the phone since
     * — so a drain that finishes a few seconds after the return still lets
     * the update apply, and one that finishes after the person is back at
     * work does not.
     */
    const hiddenReading = (returning: boolean): number | null => {
      const carried = carriedReturn.current;
      carriedReturn.current = null;
      if (returning) return hiddenClock.current.takeHiddenDuration();
      if (!carried) return null;
      const since = Date.now() - carried.since;
      const { msSinceInteraction } = activity.current.read();
      const touched = msSinceInteraction != null && msSinceInteraction < since;
      return since > RETURN_CARRY_MS || touched ? null : carried.hiddenForMs;
    };

    const runOnce = async (returning: boolean) => {
      if (applying.current) return;
      clearRecheck();
      const carriedSince = carriedReturn.current?.since ?? null;
      const hiddenForMs = hiddenReading(returning);

      const reg = await currentRegistration();
      if (cancelled) return;
      // What is on the phone comes first. An update already downloaded and
      // waiting is actionable on its own; only the question "is there a newer
      // build to go and get" needs the network, and on one bar that request
      // can take a very long time to answer or fail.
      const waiting = needRefresh || Boolean(reg?.waiting);
      const published = waiting ? null : await check.run();
      if (cancelled) return;
      const queued = waiting ? await readQueuedWork(userId.current) : null;
      if (cancelled) return;

      // Everything that says whether NOW is safe is read here, after the last
      // await and right before the decision that may reload the page.
      const action = decideUpdateAction({
        runningBuildId: BUILD_ID,
        latestBuildId: published?.buildId ?? null,
        swUpdateWaiting: waiting,
        hasUnsavedWork: hasUnsavedWork(),
        hiddenForMs,
        signedIn: signedIn.current,
        ...activity.current.read(),
        typing: isEditingText(document.activeElement),
        queuedWork: queued ? blocksReload(queued) : false,
        onSafeSurface: onSafeSurface(),
        dismissed: dismissedUntilReturn.current,
      });
      holding.current = action === "hold";

      if (action === "check") {
        if (!reg) return;
        setShown((s) => (s === "none" ? "downloading" : s));
        try {
          // The browser's own check can stall like any other request.
          await withDeadline(reg.update(), UPDATE_CHECK_TIMEOUT_MS);
        } catch {
          // Offline or the fetch failed: the next check tries again.
        }
        if (cancelled) return;
        const installing = reg.installing;
        if (!installing) {
          // Nothing new was found (yet) — do not claim a download is running.
          // Unless it was found and finished before we looked, in which case
          // decide about it now rather than on the next poll.
          if (reg.waiting) void evaluate(false);
          else setShown((s) => (s === "downloading" ? "none" : s));
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
        recheckIn(SETTLE_MS);
        setShown((s) => (s === "downloading" || s === "waiting" || s === "none" ? "ready" : s));
        return;
      }
      if (action === "hold") {
        // Keep the return-to-app reading for the cycle the queues trigger,
        // stamped with when the return actually happened.
        if (hiddenForMs != null) {
          carriedReturn.current = {
            hiddenForMs,
            since: returning ? Date.now() : (carriedSince ?? Date.now()),
          };
        }
        recheckIn(HOLD_RECHECK_MS);
        setShown("waiting");
        return;
      }
      if (action === "prompt") {
        setShown(dismissedUntilReturn.current ? "none" : "ready");
        return;
      }
      setShown("none");
    };

    /**
     * One decision cycle. `returning` is true when triggered by the app coming
     * back into view, which is the only case allowed to consume the hidden
     * duration.
     */
    const evaluate = async (returning: boolean) => {
      if (cancelled) return;
      if (running) {
        again = { returning: (again?.returning ?? false) || returning };
        return;
      }
      running = true;
      try {
        await runOnce(returning);
      } catch {
        // A check must never break the app. The next trigger tries again.
      } finally {
        running = false;
        if (!cancelled && again) {
          const next = again;
          again = null;
          void evaluate(next.returning);
        }
      }
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
    // A queue finishing is what a "hold" is waiting for. Only then: a photo
    // going out is not otherwise a reason to ask the network about builds.
    const unsubscribeQueues = subscribeQueuedWork(() => {
      if (holding.current) void evaluate(false);
    });
    // The landing mounting a moment after the app opened, with an update
    // already waiting: the check that ran at open found no safe screen yet.
    const unsubscribeSurface = subscribeSafeSurface(() => {
      if (onSafeSurface() && (needRefresh || registration.current?.waiting)) {
        void evaluate(false);
      }
    });
    void evaluate(false);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
      clearRecheck();
      unsubscribeQueues();
      unsubscribeSurface();
      check.abort();
    };
  }, [needRefresh, applyNow]);

  // Signing in starts a fresh moment; the sign-in screen is one throughout.
  useEffect(() => {
    if (!supabaseConfigured) return;
    let previous: string | null | undefined;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const id = session?.user?.id ?? null;
      signedIn.current = id !== null;
      userId.current = id;
      if (previous !== undefined && id !== null && id !== previous) {
        activity.current.markFresh();
      }
      const changed = id !== previous;
      previous = id;
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

  if (shown === "downloading" || shown === "waiting" || shown === "applying") {
    const [title, hint]: [TKey, TKey] =
      shown === "applying"
        ? ["pwa.update.applying", "pwa.update.applyingHint"]
        : shown === "waiting"
          ? ["pwa.update.waiting", "pwa.update.waitingHint"]
          : ["pwa.update.downloading", "pwa.update.downloadingHint"];
    return (
      <div className="pwa-banner pwa-banner-update" role="status" aria-live="polite">
        <span className="pwa-banner-icon" aria-hidden>
          <RefreshCw size={18} />
        </span>
        <div className="pwa-banner-text">
          <strong>{t(title)}</strong>
          <span>{t(hint)}</span>
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
        <strong>{t("pwa.update.ready")}</strong>
        <span>{t("pwa.update.readyHint")}</span>
      </div>
      <button
        type="button"
        className="wizard-btn primary pwa-banner-action"
        onClick={applyNow}
      >
        {t("pwa.update.refresh")}
      </button>
      <button
        type="button"
        className="pwa-banner-close"
        aria-label={t("pwa.update.dismiss")}
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
