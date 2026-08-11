import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { revealScrollLeft, stripEdges } from "../../lib/ui/scrollStrip";

interface ScrollTabsProps {
  /** Announced name of the tab set, e.g. "Project sections". */
  label: string;
  /** Id of the selected tab; changing it scrolls that tab back into view. */
  activeId: string;
  className?: string;
  /** Tabs. The selected one must carry `data-tab-active="true"`. */
  children: ReactNode;
}

/**
 * A row of tabs that scrolls sideways when it is wider than the phone.
 *
 * The project hub has up to nine sections. Nine is a squeeze even on the
 * office laptop and impossible on a 390px iPhone, where the row used to run off the side of
 * the screen and drag the whole page with it. Wrapping to three lines would eat
 * the top of every screen, and hiding the tail behind a "More" menu costs a tap
 * and puts a small target under a gloved thumb — so the row scrolls, and does
 * two things to stay usable in the field:
 *
 *  - it scrolls the selected tab into view, so the tab you are on is never
 *    off-screen after a tap, a reload, or a link from somewhere else;
 *  - it marks which edge has more behind it (`data-edges`) so the stylesheet can
 *    fade that side, which is the only cue that the row continues.
 */
/**
 * Width of the fade the stylesheet paints over whichever edge has more behind
 * it, plus a hair. A tab parked under the fade is half invisible, so the
 * selected one is always scrolled clear of it.
 */
const FADE_PX = 36;

export function ScrollTabs({ label, activeId, className, children }: ScrollTabsProps) {
  const ref = useRef<HTMLElement | null>(null);

  const syncEdges = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.dataset.edges = stripEdges({
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    });
  }, []);

  // Before paint, so the selected tab is never briefly off-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[data-tab-active="true"]');
    if (active) {
      const to = revealScrollLeft(
        { offsetLeft: active.offsetLeft, offsetWidth: active.offsetWidth },
        { scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth },
        FADE_PX,
      );
      if (to !== null) el.scrollTo({ left: to, behavior: "smooth" });
    }
    syncEdges();
  }, [activeId, syncEdges]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", syncEdges, { passive: true });
    const ro = new ResizeObserver(syncEdges);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", syncEdges);
      ro.disconnect();
    };
  }, [syncEdges]);

  return (
    <nav
      ref={ref}
      className={className}
      aria-label={label}
      data-edges="none"
    >
      {children}
    </nav>
  );
}
