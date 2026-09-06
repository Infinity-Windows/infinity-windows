import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronRight, HardHat } from "lucide-react";
import { myTodayCompletion } from "../../lib/toolbox";

/** Mon–Fri (local). Toolbox talks are a weekday compliance record. */
function isWeekday(d = new Date()): boolean {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

/**
 * On-the-clock toolbox-talk nag.
 *
 * The server DOES gate clock-in on today's talk — every clock_in call
 * (20260970000000_job_modes.sql) refuses without a toolbox_completions row on
 * the caller's record for today's America/Denver date — so anyone on the
 * clock has a row for the server's today, and most never see this. (A crew
 * clocked in from the roster gets one too: _file_group_toolbox_signin writes
 * a 'group' completion on each crew member's own record, and the read below
 * does not care how a row was signed.) What it exists for is the two days
 * disagreeing: the read below asks from the phone's local midnight while the
 * gate asks from Denver's, so a shift that crosses either midnight, or a
 * phone in another zone, can be on the clock with nothing on record for
 * "today" as this component counts it. Non-blocking; disappears the moment
 * today's talk is completed. Rendered only when clocked in on a weekday.
 */
export function ToolboxTalkNagBanner({
  profileId,
  clockedIn,
  onNavigate,
}: {
  profileId: string | null | undefined;
  clockedIn: boolean;
  onNavigate?: () => void;
}) {
  const enabled = Boolean(profileId) && clockedIn && isWeekday();
  const completion = useQuery({
    queryKey: ["toolboxToday", profileId],
    queryFn: () => myTodayCompletion(profileId!),
    enabled,
  });

  // Only show once we know for sure today's talk is still outstanding.
  if (!enabled || !completion.isSuccess || completion.data) return null;

  return (
    <Link
      to="/safety"
      className="toolbox-nag"
      onClick={onNavigate}
      role="alert"
    >
      <span className="toolbox-nag-icon" aria-hidden>
        <HardHat size={18} />
      </span>
      <span className="toolbox-nag-text">
        <strong>Today's toolbox talk is still due</strong>
        <span>You're on the clock — take a minute to read and sign today's safety talk.</span>
      </span>
      <ChevronRight size={18} className="toolbox-nag-chevron" aria-hidden />
    </Link>
  );
}
