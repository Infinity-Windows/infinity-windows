import { useEffect, type RefObject } from "react";

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
  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusFirst = () => {
      const el = node?.querySelector<HTMLElement>(FOCUSABLE);
      (el ?? node)?.focus();
    };
    // Defer so the element is mounted/visible before focusing.
    const raf = requestAnimationFrame(focusFirst);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
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
      previouslyFocused?.focus?.();
    };
  }, [open, ref, onClose]);
}
