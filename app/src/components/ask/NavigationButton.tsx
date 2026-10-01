import { Link } from "react-router-dom";
import { useLanguage } from "../../lib/i18n";
import { navigationHref, navigationLabel, type NavigationAction } from "../../../../supabase/functions/_shared/askNavigation";

/** A route chosen from server-verified IDs, never a URL written by the model. */
export function NavigationButton({ action }: { action: NavigationAction }) {
  const es = useLanguage().lang === "es";
  return (
    <div className="ask-navigation-action">
      <Link className="button-like ask-navigation-link" to={navigationHref(action)}>{navigationLabel(action, es)}</Link>
    </div>
  );
}
