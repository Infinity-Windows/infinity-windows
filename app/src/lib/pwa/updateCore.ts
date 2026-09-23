// Pure, browser-free heart of "the app you are running is out of date".
//
// THE PROBLEM. Installers run this as a PWA on phones. A merge to master ships
// a new bundle to GitHub Pages within a couple of minutes, but the phone keeps
// running whatever the service worker already cached. The only thing that made
// it notice was a `registration.update()` on an hour-long timer, and that timer
// does not tick while the app is backgrounded — which is most of a working day.
// So a crew member could be a whole shift behind, and a collaborator once stared
// at an old build for hours. "Deployed" was not the same as "everyone has it".
//
// THE CONSTRAINT. We may not simply reload. An installer mid-capture is holding
// a voice memo, before/after photos and a video in React state and in memory
// ONLY — see OpeningSheet. Nothing is written to IndexedDB until they submit,
// which is when installOutbox takes over and makes it durable. A reload before
// that point silently destroys work that cannot be recovered, including camera
// captures that exist nowhere else. Losing an installer's opening to a
// housekeeping reload would be far worse than them running yesterday's build.
//
// THE RULE, therefore:
//   - unsaved work                    -> ASK, never reload. No exceptions.
//   - nothing unsaved, app backgrounded a while -> reload on return. Safe:
//     there is nothing in memory to lose, and it is the moment a phone that has
//     been in a pocket all morning should catch up.
//   - nothing unsaved, just opened or just signed in, nothing typed yet ->
//     reload. The owner's call (2026-09-23): people kept running an old build
//     after opening the app, because the only silent path was "come back after
//     a minute away" and a fresh launch never counted. The first moments after
//     opening or signing in hold nothing to lose, and "Getting the newest
//     version" is on screen while it downloads, so the reload is expected.
//   - on the sign-in screen           -> reload. There is no work to lose.
//   - nothing unsaved, actively in use -> ASK. A page vanishing under someone's
//     thumb is startling even when it costs them nothing.
// Even at a safe moment, a focused text field or a tap in the last few seconds
// DEFERS it: most forms never claim unsaved work (only capture does), and a
// half-typed note is exactly what a reload would silently eat.
//
// Everything here is a pure function of serializable facts so all of that is
// testable without a service worker, a phone, or a real clock.

/**
 * How long the app must have been out of sight before we treat a reload as
 * non-disruptive. Long enough to mean the user genuinely put the phone down;
 * short enough that picking it back up gets them current within a minute.
 */
export const AUTO_RELOAD_AFTER_HIDDEN_MS = 60 * 1000;

/**
 * How long after opening the app, or signing in, an update that finishes
 * downloading is still applied without asking. Covers a normal download on
 * jobsite signal; a slower one falls back to the banner and the next return.
 */
export const FRESH_WINDOW_MS = 90 * 1000;

/**
 * A tap or keystroke this recent means somebody is mid-action: wait this long
 * after it before reloading, rather than reloading under their thumb.
 */
export const SETTLE_MS = 4 * 1000;

/** How often to ask whether a newer build exists while the app is open. */
export const VERSION_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** What to do about a possible update. */
export type UpdateAction =
  /** Nothing to do. */
  | "none"
  /**
   * A newer build exists but the service worker has not fetched it yet. Ask the
   * browser to check now, which is what eventually produces a waiting worker.
   */
  | "check"
  /** Show the banner and let the user choose. */
  | "prompt"
  /**
   * It is a safe moment, but someone is typing or just tapped. Ask again in
   * SETTLE_MS; if the moment has passed by then, that answer is "prompt".
   */
  | "defer"
  /** Apply it now — established as safe. */
  | "reload";

export interface UpdateFacts {
  /** Build id compiled into the running bundle. */
  runningBuildId: string;
  /**
   * Build id currently published, from version.json. `null` means we do not
   * know — offline, or the fetch failed. Not knowing is never a reason to act.
   */
  latestBuildId: string | null;
  /** A new service worker is installed and waiting to take over. */
  swUpdateWaiting: boolean;
  /** Someone has capture in progress that only exists in memory. */
  hasUnsavedWork: boolean;
  /**
   * How long the app was out of sight immediately before this decision, or
   * `null` if it was already visible — i.e. this decision was not triggered by
   * someone returning to the app. See createHiddenClock: the reading is
   * consumed, so a long-ago absence cannot make a reload look safe later.
   */
  hiddenForMs: number | null;
  /**
   * `false` on the sign-in screen, where there is nothing to lose. `null` or
   * absent means unknown, which is treated as signed in — the cautious reading.
   */
  signedIn?: boolean | null;
  /**
   * Time since the app was opened or someone signed in, whichever was later.
   * `null` or absent: not known, so never counts as fresh.
   */
  freshForMs?: number | null;
  /** Anything has been typed since that moment. Ends the fresh window early. */
  typedSinceFresh?: boolean;
  /** A text field has focus right now. */
  typing?: boolean;
  /** Time since the last tap or keystroke; `null` or absent: none yet. */
  msSinceInteraction?: number | null;
}

/** Is a build newer than the running one known to be published? */
export function isNewerBuildKnown(f: {
  runningBuildId: string;
  latestBuildId: string | null;
}): boolean {
  if (!f.latestBuildId) return false;
  // An unset build id would otherwise make every check look like an update.
  if (!f.runningBuildId) return false;
  return f.latestBuildId !== f.runningBuildId;
}

/**
 * The whole decision. See the rule at the top of this file for why unsaved work
 * outranks everything else.
 */
export function decideUpdateAction(f: UpdateFacts): UpdateAction {
  if (!f.swUpdateWaiting) {
    // Nothing to apply yet. Prod the browser only if we have a real reason to.
    return isNewerBuildKnown(f) ? "check" : "none";
  }

  // A waiting worker means the new build is downloaded and ready.
  if (f.hasUnsavedWork) return "prompt";

  const returning =
    f.hiddenForMs !== null && f.hiddenForMs >= AUTO_RELOAD_AFTER_HIDDEN_MS;
  const signedOut = f.signedIn === false;
  const fresh =
    f.freshForMs != null &&
    f.freshForMs <= FRESH_WINDOW_MS &&
    !f.typedSinceFresh;
  if (!returning && !signedOut && !fresh) return "prompt";

  // A safe moment — unless someone is typing or mid-tap. Coming back to the
  // app is a one-off reading (the hidden duration is consumed), so there is
  // nothing to wait for: a field still holding focus after the absence means
  // ask. The other two moments last, so they can wait a few seconds.
  const busy =
    f.typing === true ||
    (f.msSinceInteraction != null && f.msSinceInteraction < SETTLE_MS);
  if (busy) return returning && !signedOut && !fresh ? "prompt" : "defer";

  return "reload";
}

/** Shape of version.json, as emitted by the build. */
export interface BuildVersion {
  buildId: string;
  builtAt: string;
}

/**
 * Parse version.json defensively. A stale service worker, a Pages 404 page or a
 * half-deployed asset can all return something that is not this, and reporting a
 * garbage build id would nag the user forever about an update that does not
 * exist. Anything unexpected reads as "do not know".
 */
export function parseBuildVersion(raw: unknown): BuildVersion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.buildId !== "string" || r.buildId === "") return null;
  return {
    buildId: r.buildId,
    builtAt: typeof r.builtAt === "string" ? r.builtAt : "",
  };
}
