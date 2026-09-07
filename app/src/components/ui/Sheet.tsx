import { useRef, type ReactNode } from "react";
import { useFocusTrap } from "../../lib/useFocusTrap";

/**
 * A generic bottom sheet: backdrop, focus trap, Escape to close, `aria-modal`
 * — built on the same tokens and classes `CaptureSheet`
 * (components/nav/CaptureSheet.tsx) and the clock/travel/schedule sheets
 * already use (`--sheet-max-h`, `--above-tabbar`, `--ease-drawer`, the
 * `overlay-enter`/`sheet-enter` transition classes), so a sheet built with
 * this component looks and behaves like every other one in the app for free.
 *
 * Unlike `CaptureSheet`, this component owns no content of its own — it is
 * the chrome (grip, rounded top, slide-up, tap-outside-to-close), and the
 * caller supplies everything inside `children`. First use: the unit sheet's
 * post-install modal (OpeningSheet.tsx).
 */
export function Sheet({
  open,
  onClose,
  label,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  /** aria-label for the dialog — always required, even when no visible
   * title renders, since the sheet has no other accessible name. */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useFocusTrap(sheetRef, open, onClose);

  if (!open) return null;

  return (
    <>
      <div className="ui-sheet-backdrop overlay-enter" onClick={onClose} aria-hidden />
      <div
        ref={sheetRef}
        className={className ? `ui-sheet sheet-enter ${className}` : "ui-sheet sheet-enter"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <div className="ui-sheet-grip" aria-hidden />
        <div className="ui-sheet-body">{children}</div>
      </div>
    </>
  );
}
