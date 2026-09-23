// Media the service worker must never keep.
//
// The worker's runtime image cache (sw.ts) is CacheFirst for every request
// whose destination is "image" — right for job photos, wrong for the poster of
// a private "Using Forge" walkthrough, which arrives as a signed link. A cached
// copy would outlive the link's one-hour expiry and sit on the phone for a
// month under whichever account happens to use it next. So the worker asks
// this first. Kept in its own dependency-free file because sw.ts is bundled on
// its own and must not drag the Supabase client in with it.

/** The private bucket the walkthroughs live in (20261025000000). */
export const APP_TRAINING_BUCKET = "app-training";

/** True for any storage URL that points into the private walkthrough bucket,
 * signed or not. PURE — unit-tested. */
export function isPrivateTrainingMediaUrl(url: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url, "http://local.invalid").pathname);
  } catch {
    return false;
  }
  return /\/storage\/v1\/object\/(sign|authenticated|public)\/app-training\//.test(path);
}
