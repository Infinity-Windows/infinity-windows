// "Clocked in by Marlene" on a running punch (20260985000000).
//
// WHY: a supervisor can now start somebody's punch for them from the Team
// timecards roster. The person gets a push at the time, but a push is swiped
// away and a phone is off; the one place they always look is their own clock.
// So the punch itself says who started it, for as long as it is running.
//
// Renders NOTHING at all when the punch was the person's own, and nothing on a
// database that has not applied the migration — clocked_in_by simply is not on
// the row there, so there is no id to look up and no query is made. The name
// read is deliberately its own tiny query rather than a fourth `profiles!…`
// embed on SHIFT_SELECT: PostgREST answers a hard error for an embed naming a
// column it cannot find, which would take the whole clock down before the
// migration lands (see getProfileName's own comment).

import { useQuery } from "@tanstack/react-query";
import { useT } from "../../lib/i18n";
import { getProfileName, type TimeShift } from "../../lib/timeclock";

export function ClockedInByLine({ shift }: { shift: TimeShift | null }) {
  const t = useT();
  const byId = shift?.clocked_in_by ?? null;
  const who = useQuery({
    queryKey: ["profileName", byId],
    queryFn: () => getProfileName(byId!),
    enabled: Boolean(byId),
    staleTime: 5 * 60_000,
  });
  if (!byId || !who.data) return null;
  return <span className="clockin-by">{t("clock.clockedInBy", { name: who.data })}</span>;
}
