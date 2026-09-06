import { Component, type ErrorInfo, type ReactNode } from "react";
import { crashDigest, reportCrash } from "../lib/crashReport";
import { CATALOG, resolveLanguage, translate, type TKey } from "../lib/i18n";
import { readCachedLang } from "../lib/i18n/cache";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
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
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void reportCrash(error, info.componentStack);
  }

  render() {
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
