import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PwaBanners } from "./components/pwa/PwaBanners";
import { WrongProjectBanner } from "./components/WrongProjectBanner";
import "./lib/mapPolyfill";
import { installServiceWorkerGuard } from "./lib/serviceWorkerGuard";
import { installPushChangeListener } from "./lib/permissions/pushSubscribe";

// DEV only: kill orphaned service workers so a cached bundle never masks hot
// reload. Production keeps the vite-plugin-pwa worker. See serviceWorkerGuard.ts.
installServiceWorkerGuard();

// When the browser rotates a push subscription, the service worker re-subscribes
// and messages us the new subscription; persist it so the server keeps a live
// endpoint. No-op when service workers / push are unavailable.
installPushChangeListener();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
      <WrongProjectBanner />
      <PwaBanners />
    </ErrorBoundary>
  </StrictMode>,
);
