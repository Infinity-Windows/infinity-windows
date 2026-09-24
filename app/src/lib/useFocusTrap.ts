import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { claimOverlay } from "./pwa/safeSurface";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
): void {
  // Live clocks re-render parents every second, often with a new inline callback.
  // Keep Escape current without reopening the trap and scrolling back to Close.
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // A trapped modal is, by definition, something open on top of the screen.
    // Registering that here means every sheet and drawer in the app tells the
    // update banner "not a bare landing right now" without each one having to
    // remember to — see lib/pwa/safeSurface.ts.
    const releaseOverlay = claimOverlay();

    const focusFirst = () => {
      const el = node?.querySelector<HTMLElement>(FOCUSABLE);
      (el ?? node)?.focus();
    };
    // Defer so the element is mounted/visible before focusing.
    const raf = requestAnimationFrame(focusFirst);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
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
      previouslyFocused?.focus?.({ preventScroll: true });
      releaseOverlay();
    };
  }, [open, ref]);
}
