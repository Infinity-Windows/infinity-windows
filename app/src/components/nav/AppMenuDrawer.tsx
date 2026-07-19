import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { InfinityMark } from "../brand/InfinityLogo";
import { AppMenu } from "./AppMenu";
import { useFocusTrap } from "../../lib/useFocusTrap";
import type { MenuAction, MenuSection } from "../../lib/nav";

interface AppMenuDrawerProps {
  open: boolean;
  onClose: () => void;
  sections: MenuSection[];
  onNavigate?: () => void;
  onAction?: (action: MenuAction) => void;
  isActionActive?: (action: MenuAction) => boolean;
  onSignOut: () => void;
  /** Optional pinned footer (e.g. the View-as-role picker). */
  footer?: ReactNode;
}

/**
 * Mobile / tablet slide-out Menu drawer — a bottom sheet holding the same
 * grouped menu as the desktop sidebar. Opened by the "Menu" bottom-bar tab.
 */
export function AppMenuDrawer({
  open,
  onClose,
  sections,
  onNavigate,
  onAction,
  isActionActive,
  onSignOut,
  footer,
}: AppMenuDrawerProps) {
  const drawerRef = useRef<HTMLElement>(null);
  useFocusTrap(drawerRef, open, onClose);

  if (!open) return null;

  return (
    <>
      <div className="menu-drawer-backdrop overlay-enter" onClick={onClose} aria-hidden />
      <aside
        ref={drawerRef}
        className="menu-drawer sheet-enter"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
      >
        <div className="menu-drawer-grip" aria-hidden />
        <div className="menu-drawer-head">
          <span className="menu-drawer-brand">
            <InfinityMark size={22} />
            <span className="menu-drawer-title">Menu</span>
          </span>
          <button
            type="button"
            className="menu-drawer-close"
            aria-label="Close menu"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="menu-drawer-body">
          <AppMenu
            sections={sections}
            onNavigate={onNavigate}
            onAction={onAction}
            isActionActive={isActionActive}
            onSignOut={onSignOut}
          />
          {footer}
        </div>
      </aside>
    </>
  );
}
