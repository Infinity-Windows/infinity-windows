import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { claimOverlay } from "./pwa/safeSurface";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface FocusRestoreOptions {
  /** Captured for this opening, checked again when restoration actually runs. */
  canRestore?: () => boolean;
  fallback?: () => HTMLElement | null;
}
type Trap = { node: HTMLElement | null };
const traps: Trap[] = [];
let trapGeneration = 0;

function visibleEnabled(node: HTMLElement): boolean {
  if (!node.isConnected || node.matches(":disabled") || node.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}
function restoreTo(node: HTMLElement): void {
  // A stable main landmark is a useful return point when the action disappears.
  // Make it programmatically focusable only until focus leaves it.
  const temporary = !node.matches(FOCUSABLE) && !node.hasAttribute("tabindex");
  if (temporary) {
    node.tabIndex = -1;
    node.addEventListener("blur", () => {
      if (node.getAttribute("tabindex") === "-1") node.removeAttribute("tabindex");
    }, { once: true });
  }
  node.focus({ preventScroll: true });
}

/**
 * Accessible dialog behaviour for a bottom-sheet / modal container:
 * - Escape closes (calls `onClose`).
 * - Tab / Shift+Tab is trapped within the container.
 * - Focus moves into the container on open and restores to the previously
 *   focused element on close.
 *
 * Pass the container ref and the open flag. No-op while closed.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose?: () => void,
  restoreOptions?: FocusRestoreOptions,
): void {
  // Live clocks re-render parents every second, often with a new inline callback.
  // Keep Escape current without reopening the trap and scrolling back to Close.
  const closeRef = useRef(onClose);
  const restoreRef = useRef(restoreOptions);
  useLayoutEffect(() => { restoreRef.current = restoreOptions; }, [restoreOptions]);
  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const returnKey = previouslyFocused?.getAttribute("data-focus-return-key") ?? null;
    const restore = restoreRef.current; // opening lifetime, not timer-render lifetime
    const trap: Trap = { node };
    // React mounts child effects before parent effects. A simultaneously
    // mounted containing dialog must stay below its already registered child.
    const childIndex = traps.findIndex(active => !!node && !!active.node && node.contains(active.node));
    if (childIndex >= 0) traps.splice(childIndex, 0, trap);
    else traps.push(trap);
    trapGeneration++;
    const isTop = () => traps.at(-1) === trap;
    // A trapped modal is, by definition, something open on top of the screen.
    // Registering that here means every sheet and drawer in the app tells the
    // update banner "not a bare landing right now" without each one having to
    // remember to — see lib/pwa/safeSurface.ts.
    const releaseOverlay = claimOverlay();

    const focusFirst = () => {
      if (!isTop() || !node?.isConnected) return;
      const el = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).find(visibleEnabled);
      (el ?? node).focus();
    };
    // Defer so the element is mounted/visible before focusing.
    const raf = requestAnimationFrame(focusFirst);

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        visibleEnabled,
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown, true);
      const wasTop = isTop();
      const index = traps.indexOf(trap);
      if (index >= 0) traps.splice(index, 1);
      const remaining = traps.at(-1);
      const generation = trapGeneration;
      releaseOverlay();
      if (!wasTop) return;
      // Let this commit finish removing/replacing nodes. A newer opening owns
      // focus even if it also closes before this callback gets its turn.
      requestAnimationFrame(() => {
        if (generation !== trapGeneration || traps.at(-1) !== remaining || restore?.canRestore?.() === false) return;
        let target: HTMLElement | null = null;
        if (previouslyFocused && previouslyFocused !== document.body && visibleEnabled(previouslyFocused) &&
          (returnKey === null || previouslyFocused.getAttribute("data-focus-return-key") === returnKey)) target = previouslyFocused;
        if (!target && returnKey !== null) {
          const matches = Array.from(document.querySelectorAll<HTMLElement>("[data-focus-return-key]"))
            .filter(el => el.getAttribute("data-focus-return-key") === returnKey && visibleEnabled(el));
          if (matches.length === 1) target = matches[0];
        }
        if (!target) target = restore?.fallback?.() ?? null;
        if (!target || !visibleEnabled(target) || remaining && !remaining.node?.contains(target)) return;
        const active = document.activeElement;
        // A person or another surface already picked a live destination. Do
        // not overwrite that newer choice merely because cleanup was delayed.
        if (active instanceof HTMLElement && active !== document.body && active !== target &&
          visibleEnabled(active) && !node?.contains(active)) return;
        restoreTo(target);
      });
    };
  }, [open, ref]);
}
