import { Component, type ErrorInfo, type ReactNode } from "react";
import { crashDigest, reportCrash } from "../lib/crashReport";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render crashes so a single bad screen does not wipe the whole app
 * (and does NOT clear IndexedDB queues — installs/media stay queued).
 *
 * A caught crash is also REPORTED (console + the owners' suggestions list —
 * see lib/crashReport.ts): the wave-M TDZ crash hid behind this screen for a
 * whole wave because catching was all it did.
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
          <h1>Something went wrong</h1>
          <p className="muted">
            The screen crashed, but anything saved on this device (queued installs
            and photos) is still here.
          </p>
          <p className="muted">
            If you call it in, read out this code: <strong>{digest}</strong>
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="button-like button-like--primary"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button
              type="button"
              className="button-like"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
