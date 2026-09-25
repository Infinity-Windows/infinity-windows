// The one place the update banner reloads the page from. A seam, so a test
// can see the reload happen instead of losing its document to it.

/** Reload the page onto whatever service worker is in charge now. */
export function reloadPage(): void {
  window.location.reload();
}
