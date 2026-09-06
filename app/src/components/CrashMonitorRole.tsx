import { useEffect } from "react";
import { setMonitoringRole } from "../lib/monitoring/sentry";
import { useEffectiveRole } from "../lib/useEffectiveRole";

/**
 * Puts the viewer's role on every crash report, and renders nothing.
 *
 * A crash report with no idea who hit it is a report nobody can prioritise:
 * "the install sheet crashes for installers" and "the install sheet crashes
 * for the one owner previewing it" are different mornings. Role is the only
 * thing about a person that goes out — no name, no email, no id (see
 * lib/monitoring/scrub.ts) — and it is the EFFECTIVE role, so an owner
 * previewing "installer" is reported against the screen they were looking at.
 *
 * It lives in its own component because useEffectiveRole is a hook and the
 * monitor is initialised before React mounts; this is the wire between them.
 * With no DSN configured the setter is the only thing that ever runs.
 */
export function CrashMonitorRole() {
  const { effectiveRole, isLoading } = useEffectiveRole();
  useEffect(() => {
    // A null role while the profile is still loading is "not known yet", not
    // "no permissions" — so it is left alone rather than reported as a role.
    if (isLoading) return;
    setMonitoringRole(effectiveRole);
  }, [effectiveRole, isLoading]);
  return null;
}
