// Crash monitoring for the phone, and the switch that keeps it entirely optional.
//
// WHY: there is no window.onerror and no unhandledrejection handler anywhere in
// this app, so everything that breaks outside a React render is caught by
// nothing at all. The ErrorBoundary catches render crashes and now files them
// (lib/crashReport.ts), but a failed write in a promise, a broken service worker
// message or a throw inside an event handler simply vanishes off a phone in a
// field. Sentry's own global handlers close that hole the moment a DSN exists.
//
// OPTIONAL, AND OFF BY DEFAULT. With VITE_SENTRY_DSN unset — which is the state
// this ships in — nothing here runs, nothing is fetched, and the app behaves
// exactly as it did before. That is why the SDK is behind a DYNAMIC import: an
// ordinary import would put ~30 kB of monitoring in the shell every phone
// downloads before it can show anything, for a feature that is switched off.
// With the DSN unset the chunk is never requested at all — and it takes TWO
// things to make that true, because a dynamic import keeps the chunk off the
// critical path but the service worker precaches every built .js file whether
// anything asks for it or not. So vite.config.ts names this chunk
// `monitoring` and leaves it out of the precache manifest while the DSN is
// unset; with a DSN it goes back in, deliberately, because a crash in a dead
// zone cannot wait for a download.
//
// THE DSN IS PUBLIC ON PURPOSE. This repo is public and the browser DSN is
// compiled into the bundle, where anyone can read it — that is how every
// browser SDK works, and Sentry's own answer is that a DSN only permits
// SENDING events, never reading them. It is a write-only address, not a
// credential. The FUNCTIONS' DSN is a different thing and is a real secret:
// see supabase/functions/_shared/sentry.ts.
//
// NOTHING PRIVATE LEAVES. Every event goes through the shared scrubber
// (_shared/scrub.ts) in beforeSend, and every breadcrumb through it in
// beforeBreadcrumb. There is no Session Replay — recording a crew member's
// screen would ship faces, addresses and pay — and no performance tracing;
// tracesSampleRate is 0 and errors are the only thing sampled.

import { BUILD_ID } from "../pwa/buildInfo";
import {
  scrubBreadcrumb,
  scrubEvent,
  type ScrubbableBreadcrumb,
  type ScrubbableEvent,
} from "./scrub";

/** The domain the crew actually uses. Everything else is a preview. */
const PRODUCTION_HOST = "app.forgewd.com";

/**
 * The DSN this build was compiled with, or "" when there is none.
 *
 * Trimmed, because a value pasted into the GitHub secrets box arrives with a
 * newline more often than anyone expects, and " " is not a DSN.
 */
export function crashMonitoringDsn(): string {
  const raw = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  return typeof raw === "string" ? raw.trim() : "";
}

/** 'production' only on the crew's real domain; every other host is a preview. */
export function monitoringEnvironment(hostname: string): string {
  return hostname === PRODUCTION_HOST ? "production" : "preview";
}

/** The role tag, kept here so a capture from outside React can still carry it. */
let currentRole: string = "unknown";

/**
 * Tell the monitor which role is on this phone. Called from the app once the
 * profile has loaded (components/CrashMonitorRole.tsx) — the EFFECTIVE role, so
 * an owner previewing "installer" reports as the screen they are looking at.
 * A crash before that lands under "unknown", which is honest.
 */
export function setMonitoringRole(role: string | null | undefined): void {
  currentRole = role ? String(role) : "unknown";
}

/**
 * The two calls the crash path makes, and nothing else.
 *
 * Deliberately NOT `typeof import("@sentry/react")`: naming the whole module
 * here would hold a reference to the whole namespace, and a bundler cannot drop
 * what a namespace might reach. Destructuring the handful of functions actually
 * used is what lets Session Replay — which this app must never ship — be
 * deleted from the chunk rather than merely left unused.
 */
interface Monitor {
  withScope: (fn: (scope: Scope) => void) => void;
  captureException: (error: unknown) => void;
}

interface Scope {
  setTag: (key: string, value: string) => void;
  setContext: (key: string, value: Record<string, unknown> | null) => void;
}

let started: Promise<Monitor | null> | null = null;

/**
 * Load and initialise the SDK, once. Resolves to null when there is no DSN —
 * and in that case the import never happens, so the chunk is never fetched.
 *
 * Safe to call before the app mounts and safe to call again from anywhere: the
 * promise is memoised, so a crash on the very first paint waits for the same
 * initialisation rather than starting a second one.
 */
export function startCrashMonitoring(): Promise<Monitor | null> {
  if (started) return started;
  const dsn = crashMonitoringDsn();
  if (!dsn) {
    started = Promise.resolve(null);
    return started;
  }
  started = import("@sentry/react")
    .then(({ init, makeBrowserOfflineTransport, makeFetchTransport, withScope, captureException }) => {
      init({
        dsn,
        release: BUILD_ID || undefined,
        environment: monitoringEnvironment(window.location.hostname),
        // A dead-zone crash is the one worth having. The offline transport
        // stores the event in IndexedDB and sends it when signal comes back,
        // which is the difference between seeing what breaks in the field and
        // seeing only what breaks in the office.
        transport: makeBrowserOfflineTransport(makeFetchTransport),
        // Errors, all of them, and nothing else. tracesSampleRate 0 means no
        // performance data; no replayIntegration is added, so there is no
        // Session Replay to leak a crew member's screen.
        sampleRate: 1,
        tracesSampleRate: 0,
        // The SDK's own guess at "personally identifiable information" is not
        // ours. Off, and then the scrubber below does the real work.
        sendDefaultPii: false,
        integrations: (defaults) =>
          defaults.filter(
            (i) => i.name !== "Replay" && i.name !== "ReplayCanvas" && i.name !== "BrowserTracing",
          ),
        initialScope: { tags: { build: BUILD_ID || "unknown" } },
        // The double cast is deliberate: the scrubber is written against a
        // plain structural shape and knows nothing about @sentry/react, on
        // purpose — it is the same module the Deno functions use, where those
        // types do not exist. Keeping it that way is what makes one scrubber
        // possible; the cast is the seam.
        beforeSend: (event) => {
          const withTags = event as unknown as ScrubbableEvent;
          withTags.tags = {
            ...(withTags.tags ?? {}),
            role: currentRole,
            build: BUILD_ID || "unknown",
            // Read AT CAPTURE TIME, not at init: the whole point is telling a
            // crash in a dead zone apart from one in the warehouse.
            offline: String(!navigator.onLine),
          };
          return scrubEvent(withTags) as unknown as typeof event;
        },
        beforeBreadcrumb: (crumb) =>
          scrubBreadcrumb(crumb as unknown as ScrubbableBreadcrumb) as unknown as typeof crumb,
      });
      return { withScope, captureException };
    })
    .catch(() => {
      // A monitor that cannot load must not be the reason anything breaks.
      // Nothing is reported, the app carries on, and the console line the
      // crash reporter already writes is still there.
      return null;
    });
  return started;
}

/**
 * Send one caught crash, tagged with the five-character code the crew reads out.
 *
 * The code is NOT the Sentry event id. The event id is a 32-character hex string
 * nobody can say down a phone line; the code is the crew's stable reference and
 * survives across reports of the same crash site, so it is what ties "it says
 * K7F3Q" to a report. Sentry gets it as a tag and can group and search on it.
 *
 * Never throws and never rejects: it is called from the crash path.
 */
export async function captureCrash(
  error: unknown,
  componentStack: string | null | undefined,
  code: string,
): Promise<boolean> {
  try {
    const monitor = await startCrashMonitoring();
    if (!monitor) return false;
    monitor.withScope((scope) => {
      scope.setTag("crash_code", code);
      // The component stack names React components, not data — it is the one
      // piece of context that says WHICH screen died.
      if (componentStack) {
        scope.setContext("react", { componentStack: componentStack.slice(0, 2000) });
      }
      monitor.captureException(error);
    });
    return true;
  } catch {
    return false;
  }
}
