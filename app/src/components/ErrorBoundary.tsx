import { Component, type ErrorInfo, type ReactNode } from "react";
import { crashDigest, reportCrash } from "../lib/crashReport";
import { CATALOG, resolveLanguage, translate, type TKey } from "../lib/i18n";
import { readCachedLang } from "../lib/i18n/cache";
import { isChunkLoadError, recoverFromChunkLoadError } from "../lib/pwa/preloadRecovery";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /**
   * Set only when we just caught a chunk-load failure and decided to reload
   * (see componentDidCatch below). The reload is already under way — real
   * `window.location.reload()` in production, injected in tests — so render()
   * shows nothing rather than flashing "Something went wrong" for a screen
   * that was never actually broken.
   */
  reloading: boolean;
}

/**
 * The crash screen's own t().
 *
 * This boundary sits ABOVE LanguageProvider (main.tsx), and the crash it just
 * caught has unmounted whatever provider was below it — so `useT()` here would
 * answer English no matter who is holding the phone. The per-device language
 * cache is the same source the very first paint uses before any query returns,
 * and reading it is safe from anywhere (it swallows a blocked localStorage).
 * So the one screen a Spanish-reading installer is most likely to be stuck on
 * is the one that reads the cache directly.
 */
function t(key: TKey): string {
  return translate(CATALOG, resolveLanguage(null, readCachedLang()), key);
}

/**
 * Catches render crashes so a single bad screen does not wipe the whole app
 * (and does NOT clear IndexedDB queues — installs/media stay queued).
 *
 * A caught crash is also REPORTED (console + the owners' suggestions list +
 * the crash monitor when one is configured — see lib/crashReport.ts): the
 * wave-M TDZ crash hid behind this screen for a whole wave because catching
 * was all it did.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // A screen's code failing to download — a chunk a deploy renamed while
    // this tab sat open — is not a bug in the screen. In production that
    // failure raises `vite:preloadError`, which preloadRecovery.ts already
    // handles (reload once, never in a loop, never over unsaved work). The
    // Vite DEV SERVER never raises that event, though: the rejected dynamic
    // import propagates straight through React.lazy into this boundary
    // instead, so without this check a broken chunk in dev showed the crash
    // screen rather than the same one-time reload production gets. Seen
    // twice in full e2e runs under the dev server, 2026-09-07
    // (.../StudioList.tsx) — that's what made it worth fixing here.
    if (isChunkLoadError(error)) {
      const decision = recoverFromChunkLoadError();
      if (decision === "reload") {
        // The reload is already in flight; this is not a crash, so it must
        // not go through reportCrash — the offline telemetry ring already
        // logged it, same as the production path does.
        this.setState({ reloading: true });
        return;
      }
      // "notify": unsaved work on screen, or we already auto-reloaded once
      // within the last minute. Fall through to the ordinary crash screen —
      // it offers its own reload button — and report it like any other
      // caught crash, so a genuinely broken deploy still reaches the
      // crash monitor.
    }
    void reportCrash(error, info.componentStack);
  }

  render() {
    if (this.state.reloading) return null;
    if (this.state.error) {
      const digest = crashDigest(this.state.error);
      return (
        <div className="page" style={{ padding: 24, maxWidth: 420, margin: "40px auto" }}>
          <h1>{t("crash.title")}</h1>
          <p className="muted">{t("crash.saved")}</p>
          <p className="muted">
            {t("crash.readCode")} <strong>{digest}</strong>
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="button-like button-like--primary"
              onClick={() => this.setState({ error: null })}
            >
              {t("crash.tryAgain")}
            </button>
            <button
              type="button"
              className="button-like"
              onClick={() => window.location.reload()}
            >
              {t("crash.reload")}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
