import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DisplayModeProvider } from "./components/DisplayModeProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PwaBanners } from "./components/pwa/PwaBanners";
import { WrongProjectBanner } from "./components/WrongProjectBanner";
import "./lib/mapPolyfill";
import { installServiceWorkerGuard } from "./lib/serviceWorkerGuard";
import { startCrashMonitoring } from "./lib/monitoring/sentry";
import { installPushChangeListener } from "./lib/permissions/pushSubscribe";
import { installPreloadRecovery } from "./lib/pwa/preloadRecovery";
import { installClockCheck } from "./lib/clockSkew";
import { installSaveOnLeave } from "./lib/queryClient";

// Crash monitoring, started BEFORE anything mounts so a crash on the very first
// paint is still caught. With VITE_SENTRY_DSN unset — the state this ships in —
// this returns immediately and the SDK is never even fetched, so nothing about
// the app changes. Deliberately not awaited: the first paint must not wait on a
// monitoring chunk, and reportCrash awaits the same memoised promise, so a
// crash that beats the SDK to it is still reported once it lands.
void startCrashMonitoring();

// DEV only: kill orphaned service workers so a cached bundle never masks hot
// reload. Production keeps the vite-plugin-pwa worker. See serviceWorkerGuard.ts.
installServiceWorkerGuard();

// When the browser rotates a push subscription, the service worker re-subscribes
// and messages us the new subscription; persist it so the server keeps a live
// endpoint. No-op when service workers / push are unavailable.
installPushChangeListener();

// A deploy renames every chunk; a tab opened before it asks for one that is
// gone. Reload once (never over unsaved work, never in a loop) instead of a
// white screen. See lib/pwa/preloadRecovery.ts.
installPreloadRecovery();

// Release 0, K0.5: pay trusts a clock punch's tap time only when this phone
// compared its clock with the server in the last 24 hours. The comparison is
// cheap and throttles itself, so it runs at start, at sign-in, on coming back
// to the foreground and when the network returns — a phone opened in the
// morning with signal is still trusted for the evening clock-out in a dead
// zone. Silent when offline: the last good check stands. See lib/clockSkew.ts.
installClockCheck();

// The phone's copy of what the screens last read is written on a one-second
// timer; this also writes it the moment the app is hidden or reloaded, so a
// reopen with no signal never finds it empty. See lib/queryClient.ts.
installSaveOnLeave();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <DisplayModeProvider><App /></DisplayModeProvider>
      <WrongProjectBanner />
      <PwaBanners />
    </ErrorBoundary>
  </StrictMode>,
);
