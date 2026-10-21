import { Menu } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage, useT } from "../../lib/i18n";
import { ClockBadge } from "../clock/ClockBadge";
import { SyncStatusPill } from "../offline/SyncStatusPill";
import logo from "./forge-steel-logo.jpg";

export function SteelBrand() {
  return <Link to="/" className="steel-brand" aria-label="Forge Windows home">
    <img src={logo} alt="Forge Windows and Doors" />
  </Link>;
}

/** Navigation and status only: clock actions retain their existing owner. */
export function SteelHeader({ onOpenMenu, menuOpen }: {
  onOpenMenu: () => void;
  menuOpen: boolean;
}) {
  const t = useT();
  const es = useLanguage().lang === "es";
  return <header className="steel-header">
    <button type="button" className="steel-menu" onClick={onOpenMenu}
      aria-label={t("nav.more.a11y")} aria-expanded={menuOpen}>
      <Menu size={22} aria-hidden />
    </button>
    <Link to="/" className="steel-mobile-brand" aria-label="Forge Windows home">
      <img src={logo} alt="Forge Windows and Doors" />
    </Link>
    <span className="steel-header-title">{es ? "Tu espacio de trabajo" : "Your workspace"}</span>
    <div className="steel-header-status"><ClockBadge /><SyncStatusPill /></div>
  </header>;
}
