// The one place the update banner reloads the page from. A seam, so a test
// can see the reload happen instead of losing its document to it.

/** Reload the page onto whatever service worker is in charge now. */
export function reloadPage(reason: "controllerchange" | "takeover-fallback" = "controllerchange"): void {
  try {
    sessionStorage.setItem("wops-update-reload-diagnostic", JSON.stringify({ at: Date.now(), reason }));
  } catch {
    // Private browsing can block storage. Updating must still work.
  }
  console.info("FORGE-PWA-PAGE-RELOAD", JSON.stringify({at:Date.now(),reason}));
  window.location.reload();
}
