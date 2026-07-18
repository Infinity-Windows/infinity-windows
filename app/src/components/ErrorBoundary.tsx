import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render crashes so a single bad screen does not wipe the whole app
 * (and does NOT clear IndexedDB queues — installs/media stay queued).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("App render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page" style={{ padding: 24, maxWidth: 420, margin: "40px auto" }}>
          <h1>Something went wrong</h1>
          <p className="muted">
            The screen crashed, but anything saved on this device (queued installs
            and photos) is still here. Reload to continue.
          </p>
          <button
            type="button"
            className="button-like"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
