// Foreman+ on Work (crew redesign K1.1: "Foremen's Jobs moves onto their
// Work screen and More", and the crew-summary slot of K1.2 item 5, which
// stays empty until Release 3's crew board). One row of doors, nothing
// Jobs for every lead and Team timecards for every lead. Jobs now includes
// the supervisor/owner overview, so it needs no separate Heartbeat door.

import { Link } from "react-router-dom";
import { LayoutGrid, Users } from "lucide-react";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";

export function LeadRow() {
  const t = useT();
  return (
    <nav className="ws-lead" aria-label={t("work.lead.jobs")} data-testid="ws-lead">
      <Link to="/projects" className="ws-btn ws-quick-btn">
        <LayoutGrid size={20} aria-hidden /> {t("work.lead.jobs")}
      </Link>
      <Link to="/team-timecards" className="ws-btn ws-quick-btn">
        <Users size={20} aria-hidden /> {t("work.lead.timecards")}
      </Link>
    </nav>
  );
}
