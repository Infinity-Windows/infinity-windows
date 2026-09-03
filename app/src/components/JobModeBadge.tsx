// A small "Data" / "Tracking" / "Data + Tracking" pill so every job wears its
// mode at a glance (standard-tracking-jobs slice 2) — on the jobs list, in the
// clock-in job list, and on the job header.

import { modeBadgeKey } from "../lib/jobModes";
import type { JobMode } from "../lib/types";
import { useT } from "../lib/i18n";

export function JobModeBadge({
  allowed,
  className,
}: {
  allowed?: JobMode[] | null;
  className?: string;
}) {
  const t = useT();
  return (
    <span className={className ? `job-mode-badge ${className}` : "job-mode-badge"}>
      {t(modeBadgeKey(allowed))}
    </span>
  );
}
