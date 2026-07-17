import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./lib/mapPolyfill";
import { installServiceWorkerGuard } from "./lib/serviceWorkerGuard";

// Kill any stale/orphaned service worker on this origin before rendering so a
// cached bundle can never mask new code (dev or prod). See serviceWorkerGuard.ts.
installServiceWorkerGuard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
