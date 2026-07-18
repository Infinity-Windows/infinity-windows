import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./lib/mapPolyfill";
import { installServiceWorkerGuard } from "./lib/serviceWorkerGuard";

// DEV only: kill orphaned service workers so a cached bundle never masks hot
// reload. Production keeps the vite-plugin-pwa worker. See serviceWorkerGuard.ts.
installServiceWorkerGuard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
