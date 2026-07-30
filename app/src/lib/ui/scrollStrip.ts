/**
 * Geometry for a horizontally scrolling strip of tabs.
 *
 * A phone cannot show eight tabs at once, so the project hub's tab row scrolls
 * sideways. Two things then have to be true or the row is worse than useless to
 * an installer holding the phone in one gloved hand: it must be obvious that
 * there is more to the left or right, and the tab you are actually on must
 * already be on screen — nobody should have to go looking for the tab they just
 * tapped, or for "Overview" after a reload.
 *
 * The maths lives here, away from the DOM, so both rules can be tested.
 */

/** Which side(s) of a strip still have content hidden past the edge. */
export type StripEdges = "none" | "start" | "end" | "both";

export interface StripMetrics {
  /** How far the strip is scrolled from its start edge, in CSS pixels. */
  scrollLeft: number;
  /** Full width of the content inside the strip. */
  scrollWidth: number;
  /** Visible width of the strip. */
  clientWidth: number;
}

export interface StripItem {
  /** Item's left edge relative to the start of the strip's content. */
  offsetLeft: number;
  offsetWidth: number;
}

/**
 * Sub-pixel slack. Browsers routinely report a scrollWidth a fraction wider
 * than clientWidth for a strip that visibly fits, and a 0.5px "there is more
 * over here" hint is a lie.
 */
const SLACK = 1;

export function stripEdges(m: StripMetrics, slack = SLACK): StripEdges {
  const maxScroll = m.scrollWidth - m.clientWidth;
  if (maxScroll <= slack) return "none";
  const atStart = m.scrollLeft <= slack;
  const atEnd = m.scrollLeft >= maxScroll - slack;
  if (atStart) return "end";
  if (atEnd) return "start";
  return "both";
}

/**
 * Where to scroll so `item` is fully visible, or `null` when it already is.
 *
 * `padding` keeps a sliver of the neighbouring tab in view rather than butting
 * the selected one flush against the edge, which is what makes it read as a
 * strip that continues rather than as the last tab there is.
 */
export function revealScrollLeft(
  item: StripItem,
  m: StripMetrics,
  padding = 24,
): number | null {
  const maxScroll = Math.max(0, m.scrollWidth - m.clientWidth);
  if (maxScroll <= 0) return null;

  const itemStart = item.offsetLeft;
  const itemEnd = item.offsetLeft + item.offsetWidth;
  const viewStart = m.scrollLeft;
  const viewEnd = m.scrollLeft + m.clientWidth;

  let target: number | null = null;
  if (itemStart - padding < viewStart) {
    target = itemStart - padding;
  } else if (itemEnd + padding > viewEnd) {
    target = itemEnd + padding - m.clientWidth;
  }
  if (target === null) return null;

  const clamped = Math.min(maxScroll, Math.max(0, Math.round(target)));
  return clamped === Math.round(m.scrollLeft) ? null : clamped;
}
