// My timecard: YOUR hours, whoever you are. Leads manage the crew (and
// their own punches) on /team-timecards; this tab is deliberately the same
// read-only personal panel for everyone, so "My timecard" always means me.

import { BackChip } from "../components/BackChip";
import { useQuery } from "@tanstack/react-query";
import { getMyProfile } from "../lib/install/api";
import { getOpenShift, listCostCodes } from "../lib/timeclock";
import { listProjects } from "../lib/api";
import { TimecardPanel } from "../components/timecard/TimecardPanel";

export function Timecard() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const costCodes = useQuery({ queryKey: ["costCodes"], queryFn: listCostCodes });
  const myOpen = useQuery({
    queryKey: ["openShift", me.data?.id],
    queryFn: () => getOpenShift(me.data!.id),
    enabled: Boolean(me.data?.id),
    refetchInterval: 60_000,
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>My timecard</h1>
          <p className="muted" style={{ margin: 0 }}>Your hours</p>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>
      {me.data?.id && (
        <TimecardPanel
          personId={me.data.id}
          personName={me.data.display_name}
          isLead={false}
          isSup={false}
          canEdit={false}
          projects={projects.data ?? []}
          costCodes={costCodes.data ?? []}
          openShift={myOpen.data ?? null}
        />
      )}
    </div>
  );
}
