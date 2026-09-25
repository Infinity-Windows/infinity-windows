// Where the newest thing in an Ask conversation lands on the screen.
//
// The owner, dictating a daily log on an iPhone (2026-09-24): "the chat goes
// through above those options so I have to scroll up to see the response …
// it should be the most recent thing I see." The thread sits ABOVE the daily
// log card, the action cards and the composer, so a reply arrives out of view
// whenever the person is down at those. The old follow-scroll also aimed at an
// empty marker after the thread with `block: "nearest"`, which pinned the
// marker to the top edge and left the reply itself just above the screen.
//
// The geometry is pure and tested here; the page measures and scrolls.

/** A vertical span in viewport pixels (getBoundingClientRect's top/bottom). */
export interface Span { top: number; bottom: number }

/** Breathing room between the newest message and whatever it is revealed against. */
export const REVEAL_GAP = 12;

/** How far a message may hang below the visible band and still count as "at
 * the end" — the last line of a reply half under the tab bar is not someone
 * who scrolled away to read older messages. */
export const FOLLOW_SLACK = 48;

/**
 * How far to scroll (positive = down) so `box` shows inside `band`. Zero when
 * it already does. A box taller than the band shows its START — a long reply
 * is read from the top — and otherwise the smallest move wins, so the person
 * keeps as much of where they were as possible: a message above them lands at
 * the top of the band with the cards and daily log still under it; one below
 * them lands just above the tab bar.
 */
export function revealDelta(box: Span, band: Span): number {
  if (box.top >= band.top && box.bottom <= band.bottom) return 0;
  if (box.bottom - box.top > band.bottom - band.top || box.top < band.top) return box.top - band.top;
  return box.bottom - band.bottom;
}

/**
 * Was the person reading older messages when a new one arrived? Yes when the
 * message that WAS newest still ends below the visible band: they scrolled up,
 * away from the end, on purpose. Someone at the end of the thread — or below
 * it, at the cards, the daily log or the composer — is following along, and
 * the new message comes to them.
 */
export function readingHistory(previousNewest: Span | null, band: Span): boolean {
  return previousNewest !== null && previousNewest.bottom > band.bottom + FOLLOW_SLACK;
}

/** Is any of `box` inside `band`? (The jump button goes once the new message
 * is on screen, however the person got it there.) */
export function inBand(box: Span, band: Span): boolean {
  return box.bottom > band.top && box.top < band.bottom;
}

/** The union of the spans that exist — the newest message plus, while an
 * answer is on its way, the "Finding an answer…" bubble under it. */
export function unionSpan(spans: Array<Span | null>): Span | null {
  const real = spans.filter((s): s is Span => s !== null && s.bottom > s.top);
  if (!real.length) return null;
  return { top: Math.min(...real.map((s) => s.top)), bottom: Math.max(...real.map((s) => s.bottom)) };
}

/** Where `el` is on screen, or null when it is absent or takes no space. */
export function spanOf(el: Element | null | undefined): Span | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.height > 0 ? { top: r.top, bottom: r.bottom } : null;
}

/**
 * The band of the screen nothing pinned covers: inside the visual viewport
 * (an open keyboard shrinks it), below the phone's sticky sync strip when it
 * is stuck to the top, above the phone tab bar, and above `pinnedBottom` —
 * the recorder while it is pinned. The shell's classes are read here rather
 * than threaded through props because they are the shell's own pinned edges;
 * on a laptop both are display:none and measure as nothing.
 */
export function visibleBand(pinnedBottom: Element | null): Span {
  const vv = typeof window.visualViewport === "object" ? window.visualViewport : null;
  let top = vv ? vv.offsetTop : 0;
  let bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const strip = spanOf(document.querySelector(".sync-strip"));
  // In flow at the top of a page that has not been scrolled; only once it is
  // stuck to the top edge does it cover anything.
  if (strip && strip.top <= top + 1 && strip.bottom > top) top = strip.bottom;
  for (const el of [document.querySelector(".tabbar"), pinnedBottom]) {
    const s = spanOf(el);
    if (s && s.top < bottom && s.bottom > top) bottom = s.top;
  }
  return { top: top + REVEAL_GAP, bottom: bottom - REVEAL_GAP };
}

/** Scroll the page by `delta`, gently unless the phone asks for less motion. */
export function scrollPageBy(delta: number): void {
  if (Math.abs(delta) < 1) return;
  const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollBy({ top: delta, behavior: still ? "auto" : "smooth" });
}

/** A field that raises the phone keyboard: a textarea, an editable element or
 * a text-like input (not a checkbox, a file picker or a button). */
export function isTextEntry(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement || el.isContentEditable) return true;
  return el instanceof HTMLInputElement && !NOT_TYPING.has(el.type);
}
const NOT_TYPING = new Set(["button", "checkbox", "radio", "submit", "reset", "file", "range", "color", "image", "hidden"]);
