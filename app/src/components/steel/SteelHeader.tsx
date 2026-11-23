import { Link } from "react-router-dom";
import { useLanguage } from "../../lib/i18n";
import { ClockBadge } from "../clock/ClockBadge";
import { SyncStatusPill } from "../offline/SyncStatusPill";
import logo from "./forge-steel-logo.jpg";

export function SteelBrand() {
  return <Link to="/" className="steel-brand" aria-label="Forge Windows home">
    <img src={logo} alt="Forge Windows and Doors" />
  </Link>;
}

/**
 * The brand and the status only: clock actions retain their existing owner.
 * No menu button. More in the bottom bar opens the same drawer, and the one up
 * here was the hardest thing on a phone to reach (Ammon, 2026-11-22: "we don't
 * need the menu up there. Logo is good"). At desktop width the rail is the menu.
 */
export function SteelHeader() {
  const es = useLanguage().lang === "es";
  return <header className="steel-header">
    <Link to="/" className="steel-mobile-brand" aria-label="Forge Windows home">
      <img src={logo} alt="Forge Windows and Doors" />
    </Link>
    <span className="steel-header-title">{es ? "Tu espacio de trabajo" : "Your workspace"}</span>
    <div className="steel-header-status"><ClockBadge /><SyncStatusPill /></div>
  </header>;
}
