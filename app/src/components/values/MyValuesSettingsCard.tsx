/**
 * Settings → "My values" card (20261106000000). Reuses the existing Settings
 * menu destination rather than adding a bottom-bar tab or a new top-level
 * menu row — the owner instruction (2026-10-03) is explicitly "no bottom-bar
 * expansion" and "reuse that existing menu destination". Owners reach the
 * review matrix from the same card.
 */
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { useValuesT } from "../../lib/i18n/valuesCatalog";
import { fetchMyValuesOwedCount } from "../../lib/values/api";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { signedInUserId, signInGeneration, subscribeSignedIn } from "../../lib/signedIn";
import { useConnection } from "../../lib/offline/useWeakSignal";

export function MyValuesSettingsCard() {
  const vt = useValuesT();
  const { realRole, isPreviewing } = useEffectiveRole();
  const ownerId = useSyncExternalStore(subscribeSignedIn, signedInUserId, signedInUserId);
  const authGeneration = useSyncExternalStore(subscribeSignedIn, signInGeneration, signInGeneration);
  const { online } = useConnection();
  const owed = useQuery({ queryKey: ["valuesMyTasks", ownerId, authGeneration, "owedCount"], queryFn: fetchMyValuesOwedCount, enabled: Boolean(ownerId && online), refetchOnMount: "always", networkMode: "online", retry: false, gcTime: 0 });
  const count = owed.data;

  return (
    <section className="detail-card" style={{ marginBottom: 12 }}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>{vt("values.settings.heading")}</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{vt("values.settings.help")}</p>
      {online && owed.fetchStatus !== "paused" && (owed.isPending || owed.isFetching) && <p className="muted">{vt("values.tasks.loading")}</p>}
      {(!online || owed.fetchStatus === "paused" || owed.isError) && <p role="alert">{vt("values.tasks.unavailable")}</p>}
      {online && owed.fetchStatus !== "paused" && owed.isSuccess && !owed.isFetching && count != null && count > 0 && (
        <p className="muted" style={{ marginTop: 0, fontWeight: 600 }}>
          {vt(count === 1 ? "values.settings.owedBadge.one" : "values.settings.owedBadge.many", { n: count })}
        </p>
      )}
      <div className="row-gap">
        <Link to="/values" className="action-btn" data-testid="open-values">
          {vt("values.settings.open")}
        </Link>
        {realRole === "owner" && !isPreviewing && (
          <Link to="/values/owner" className="button-like" data-testid="open-values-owner">
            {vt("values.owner.heading")}
          </Link>
        )}
      </div>
    </section>
  );
}
