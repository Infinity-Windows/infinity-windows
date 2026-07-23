import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "../../lib/useFocusTrap";

/** Shared bottom-sheet dialog for the travel editors. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="travel-sheet-backdrop overlay-enter" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        className="travel-sheet sheet-enter"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="travel-sheet-head">
          <h2 className="travel-sheet-title">{title}</h2>
          <button type="button" className="capture-close" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="travel-sheet-body">{children}</div>
        {footer && <div className="travel-sheet-actions">{footer}</div>}
      </div>
    </>
  );
}
