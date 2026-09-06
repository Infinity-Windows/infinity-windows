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
 * The server DOES gate the day's first punch on today's talk — clock_in in
 * 20260970000000_job_modes.sql refuses it without a toolbox_completions row
 * for today's America/Denver date — so most people on the clock have already
 * signed and never see this. It exists for the ones who can be on the clock
 * with nothing on their own record: a crew clocked in from the roster on a
 * supervisor's group attestation (a 'group' completion, not a signature), or
 * a phone whose local midnight has passed while the server's day has not, so
 * "today" differs between the two. Non-blocking; disappears the moment today's
 * talk is completed. Rendered only when clocked in on a weekday.
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
