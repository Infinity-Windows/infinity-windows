// The UI half of lazyOptional.tsx, for a lazily-loaded part that is what the
// person came to see (a job hub tab, a Learn tab, a map) rather than an extra
// on a screen. When its code never arrived, the part says so in its own place
// instead of leaving a blank, and the rest of the app stays usable. Split out
// for the same reason as lazyRouteFallback.tsx: a module that exports both a
// component and a non-component trips react/only-export-components.

import { useT } from "../i18n";
import { EmptyState } from "../../components/ui/States";

/**
 * In place of a part whose code did not download. Opening the part again
 * tries the download again (lazyOptional.tsx has the rules).
 */
export function PartDidNotLoad() {
  const t = useT();
  return <EmptyState title={t("lazyRoute.hung")} />;
}
