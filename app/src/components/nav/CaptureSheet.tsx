import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Camera, ListChecks, NotebookPen, ScanLine, Search, X } from "lucide-react";
import type { RoutePath } from "../../lib/nav";

interface CaptureSheetProps {
  open: boolean;
  onClose: () => void;
}

interface CaptureAction {
  to: RoutePath;
  label: string;
  Icon: typeof Camera;
}

const ACTIONS: CaptureAction[] = [
  { to: "/scan", label: "Scan a unit", Icon: ScanLine },
  { to: "/photos", label: "Photos & receipts", Icon: Camera },
  { to: "/count", label: "Cycle count", Icon: ListChecks },
  { to: "/daily-logs", label: "Daily log", Icon: NotebookPen },
  { to: "/search", label: "Find a window", Icon: Search },
];

/** Quick-capture bottom sheet opened by the center Capture (+) FAB. */
export function CaptureSheet({ open, onClose }: CaptureSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="capture-backdrop overlay-enter" onClick={onClose} aria-hidden />
      <div className="capture-sheet sheet-enter" role="dialog" aria-modal="true" aria-label="Quick capture">
        <div className="capture-grip" aria-hidden />
        <div className="capture-head">
          <h2 className="capture-title">Capture</h2>
          <button type="button" className="capture-close" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="capture-grid">
          {ACTIONS.map(({ to, label, Icon }) => (
            <Link key={to} to={to} className="capture-tile" onClick={onClose}>
              <span className="capture-tile-icon">
                <Icon size={22} />
              </span>
              <span className="capture-tile-label">{label}</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
