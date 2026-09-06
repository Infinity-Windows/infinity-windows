// YouTube's IFrame Player API, loaded lazily and never trusted to arrive.
//
// WHY IT IS NEEDED AT ALL. A plain <iframe> embed plays a lesson perfectly well
// and tells the page nothing: not whether it is playing, not where the play
// head is, not whether it reached the end. The owner's question — "do they
// watch the whole thing, and how many times" — cannot be answered without those
// three, so the embed gains `enablejsapi=1` and this file talks to it.
//
// WHY LAZILY, AND ONLY ON THE VIDEO PAGE. It is a third-party script. Loading
// it on boot would put it in front of the clock-in screen for every installer
// every morning, including the ones who never open Learn, and on a phone with
// two bars that is a real cost. It is fetched the first time a lesson card
// renders and once per page after that.
//
// WHY EVERY FAILURE IS SILENT. If the script is blocked, the network drops, or
// the API never signals ready, the lesson still plays — the iframe is a normal
// embed and does not need this to work. What is lost is the recording, and a
// crew member watching a lesson on bad signal must never be shown an error
// about telemetry they did not ask for. Degrade, never break playback.

/** The slice of the YouTube API this app uses. Nothing else is touched. */
export interface YouTubePlayer {
  getCurrentTime(): number;
  getDuration(): number;
  destroy(): void;
}

/** Player states, as YouTube numbers them. */
export const YT_STATE = {
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

export interface YouTubeApi {
  Player: new (
    element: HTMLElement | string,
    options: {
      events?: {
        onReady?: (event: { target: YouTubePlayer }) => void;
        onStateChange?: (event: { data: number; target: YouTubePlayer }) => void;
        onError?: () => void;
      };
    },
  ) => YouTubePlayer;
}

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const SRC = "https://www.youtube.com/iframe_api";
/** Long enough for a slow phone, short enough not to hold a promise forever. */
const READY_TIMEOUT_MS = 15_000;

let pending: Promise<YouTubeApi | null> | null = null;

/**
 * The API object, or null when it could not be had. Loads the script at most
 * once per page; every later caller gets the same promise.
 *
 * Never rejects. A caller that has to branch on "did this work" reads the null.
 */
export function loadYouTubeIframeApi(): Promise<YouTubeApi | null> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.resolve(null);
  }
  // Already there — another card on the page loaded it, or a test stubbed it.
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (pending) return pending;

  pending = new Promise<YouTubeApi | null>((resolve) => {
    let settled = false;
    const done = (api: YouTubeApi | null) => {
      if (settled) return;
      settled = true;
      // A failed load is not cached: the next lesson card gets to try again,
      // which is what somebody who has just walked back into signal expects.
      if (!api) pending = null;
      resolve(api);
    };

    // YouTube calls exactly one global when it is ready. Chain rather than
    // replace: another copy of this app (or a future caller) may have set one,
    // and stealing it would leave that one waiting forever.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      done(window.YT ?? null);
    };

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SRC}"]`,
    );
    if (!existing) {
      const script = document.createElement("script");
      script.src = SRC;
      script.async = true;
      script.onerror = () => done(null);
      document.head.appendChild(script);
    }

    setTimeout(() => done(window.YT ?? null), READY_TIMEOUT_MS);
  });
  return pending;
}

/** Test seam: forget that the script was ever asked for. */
export function resetYouTubeApiLoader(): void {
  pending = null;
}
