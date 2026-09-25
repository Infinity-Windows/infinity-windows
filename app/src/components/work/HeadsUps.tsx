// The heads-up lines on Work (crew redesign K1.9, 2026-09-23). One line
// each, a door each, at most three — decided by lib/work/headsUps.ts.

import { Link } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import type { HeadsUp } from "../../lib/work/headsUps";

export function HeadsUps({ items }: { items: HeadsUp[] }) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <ul className="ws-headsups" aria-label={t("work.headsUp.a11y")} data-testid="ws-headsups">
      {items.map((h) => (
        <li key={h.id}>
          <Link to={h.to} className="ws-headsup" data-headsup={h.id}>
            <AlertCircle size={18} aria-hidden />
            <span>{t(h.key, h.vars)}</span>
            <span aria-hidden>›</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
