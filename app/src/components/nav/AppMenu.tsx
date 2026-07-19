import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronRight, LogOut } from "lucide-react";
import type { MenuAction, MenuItem, MenuSection } from "../../lib/nav";

interface AppMenuProps {
  sections: MenuSection[];
  /** Called after a navigation link is clicked (e.g. close the drawer). */
  onNavigate?: () => void;
  onAction?: (action: MenuAction) => void;
  isActionActive?: (action: MenuAction) => boolean;
  onSignOut: () => void;
}

function pathIsActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(to + "/");
}

/**
 * The grouped Horizon-style menu shared by the desktop sidebar and the mobile
 * slide-out drawer. Top group has no header; TIME TRACKING / BUSINESS render as
 * solid coral collapsible pills; COMPANY / TOOLS / ACCOUNT are labelled groups.
 */
export function AppMenu({
  sections,
  onNavigate,
  onAction,
  isActionActive,
  onSignOut,
}: AppMenuProps) {
  return (
    <div className="app-menu">
      {sections.map((section, i) =>
        section.pill ? (
          <MenuPill
            key={section.title ?? `pill-${i}`}
            section={section}
            onNavigate={onNavigate}
            onAction={onAction}
            isActionActive={isActionActive}
          />
        ) : (
          <div className="menu-group" key={section.title ?? `group-${i}`}>
            {section.title && <p className="menu-section-title">{section.title}</p>}
            <ul className="menu-list">
              {section.items.map((item) => (
                <MenuRow
                  key={item.to ?? item.action ?? item.label}
                  item={item}
                  onNavigate={onNavigate}
                  onAction={onAction}
                  isActionActive={isActionActive}
                />
              ))}
            </ul>
          </div>
        ),
      )}

      <div className="menu-group menu-signout-group">
        <button type="button" className="menu-item menu-signout" onClick={() => void onSignOut()}>
          <span className="menu-item-icon">
            <LogOut size={18} />
          </span>
          <span className="menu-item-label">Sign out</span>
        </button>
      </div>
    </div>
  );
}

function MenuPill({
  section,
  onNavigate,
  onAction,
  isActionActive,
}: {
  section: MenuSection;
  onNavigate?: () => void;
  onAction?: (action: MenuAction) => void;
  isActionActive?: (action: MenuAction) => boolean;
}) {
  const location = useLocation();
  const hasActiveChild = section.items.some(
    (it) =>
      (it.to && pathIsActive(location.pathname, it.to)) ||
      (it.action && (isActionActive?.(it.action) ?? false)),
  );
  const [open, setOpen] = useState<boolean>(section.defaultOpen ?? hasActiveChild);
  const PillIcon = section.Icon;

  return (
    <div className="menu-group">
      <button
        type="button"
        className={`menu-pill${open ? " open" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {PillIcon && (
          <span className="menu-pill-icon">
            <PillIcon size={18} />
          </span>
        )}
        <span className="menu-pill-label">{section.title}</span>
        <ChevronRight className="menu-pill-chevron" size={16} />
      </button>
      {open && (
        <ul className="menu-list menu-pill-body">
          {section.items.map((item) => (
            <MenuRow
              key={item.to ?? item.action ?? item.label}
              item={item}
              onNavigate={onNavigate}
              onAction={onAction}
              isActionActive={isActionActive}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MenuRow({
  item,
  onNavigate,
  onAction,
  isActionActive,
}: {
  item: MenuItem;
  onNavigate?: () => void;
  onAction?: (action: MenuAction) => void;
  isActionActive?: (action: MenuAction) => boolean;
}) {
  const { to, label, Icon, action, external } = item;

  if (action) {
    const active = isActionActive?.(action) ?? false;
    return (
      <li>
        <button
          type="button"
          className={`menu-item${active ? " active" : ""}`}
          onClick={() => onAction?.(action)}
        >
          <span className="menu-item-icon">
            <Icon size={18} />
          </span>
          <span className="menu-item-label">{label}</span>
        </button>
      </li>
    );
  }

  if (!to) return null;

  if (external) {
    return (
      <li>
        <a
          className="menu-item"
          href={to}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => onNavigate?.()}
        >
          <span className="menu-item-icon">
            <Icon size={18} />
          </span>
          <span className="menu-item-label">{label}</span>
        </a>
      </li>
    );
  }

  return (
    <li>
      <NavLink
        to={to}
        end={to === "/"}
        className={({ isActive }) => `menu-item${isActive ? " active" : ""}`}
        onClick={() => onNavigate?.()}
      >
        <span className="menu-item-icon">
          <Icon size={18} />
        </span>
        <span className="menu-item-label">{label}</span>
      </NavLink>
    </li>
  );
}
