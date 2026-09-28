// Foreman+ on Work (crew redesign K1.1: "Foremen's Jobs moves onto their
// Work screen and More", and the crew-summary slot of K1.2 item 5, which
// stays empty until Release 3's crew board). One row of doors, nothing
// removed from the app: Jobs for every lead, Team timecards for every lead,
// Overview (the classic Heartbeat) for supervisors and owners.

import { Link } from "react-router-dom";
import { Activity, LayoutGrid, Users } from "lucide-react";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { isSupervisorPlus } from "../../lib/install/types";

export function LeadRow({ role }: { role: string | null | undefined }) {
  const t = useT();
  return (
    <nav className="ws-lead" aria-label={t("work.lead.jobs")} data-testid="ws-lead">
      <Link to="/projects" className="ws-btn ws-quick-btn">
        <LayoutGrid size={20} aria-hidden /> {t("work.lead.jobs")}
      </Link>
      <Link to="/team-timecards" className="ws-btn ws-quick-btn">
        <Users size={20} aria-hidden /> {t("work.lead.timecards")}
      </Link>
      {isSupervisorPlus(role) && (
        <Link to="/heartbeat" className="ws-btn ws-quick-btn">
          <Activity size={20} aria-hidden /> {t("work.lead.overview")}
        </Link>
      )}
    </nav>
  );
}
