// My timecard: YOUR hours, whoever you are. Leads manage the crew (and
// their own punches) on /team-timecards. Foremen and above can also correct
// their own entries here; "My timecard" always means me.

import { BackChip } from "../components/BackChip";
import { useQuery } from "@tanstack/react-query";
import { getMyProfile } from "../lib/install/api";
import { listCostCodes } from "../lib/timeclock";
import { useOpenShiftView } from "../lib/useOpenShiftView";
import { listProjects } from "../lib/api";
import { TimecardPanel } from "../components/timecard/TimecardPanel";
import { SignMyTimecardCard } from "../components/timecard/SignOffCard";
import { useT } from "../lib/i18n";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { isForemanPlus } from "../lib/install/types";

export function Timecard() {
  const t = useT();
  const { effectiveRole } = useEffectiveRole();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const costCodes = useQuery({ queryKey: ["costCodes"], queryFn: listCostCodes });
  // The live hero counts from the shift as this phone knows it — a clock-in
  // still in the queue included (K0.1).
  const myOpen = useOpenShiftView(me.data?.id ?? null, { poll: true });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{t("timecard.pageTitle")}</h1>
          <p className="muted" style={{ margin: 0 }}>{t("timecard.pageSubtitle")}</p>
        </div>
        <BackChip fallback="/" label={t("timecard.home")} />
      </header>
      {me.data?.id && <SignMyTimecardCard profileId={me.data.id} />}
      {me.data?.id && (
        <TimecardPanel
          personId={me.data.id}
          personName={me.data.display_name}
          isLead={false}
          isSup={false}
          canEdit={isForemanPlus(effectiveRole)}
          canApprove={isForemanPlus(effectiveRole)}
          projects={projects.data ?? []}
          costCodes={costCodes.data ?? []}
          openShift={myOpen.shift}
        />
      )}
    </div>
  );
}
