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
 * Post-clock-in toolbox-talk nag. Clocking in is NOT gated on the talk anymore
 * (installers can always start their shift); this non-blocking banner nudges
 * them to read & sign today's safety talk while on the clock. It disappears the
 * moment today's talk is completed. Rendered only when clocked in on a weekday.
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
