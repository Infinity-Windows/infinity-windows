import { useQuery } from "@tanstack/react-query";
import { getCrewGoal } from "../../lib/crewGoal";
import { getRealProfile } from "../../lib/install/api";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";

const number = (value: number) => `${value.toFixed(1)} h`;

export function CrewGoalCard({ projectId }: { projectId: string }) {
  const t = useT();
  const me = useQuery({ queryKey: ["myRealProfile"], queryFn: getRealProfile });
  const goal = useQuery({
    queryKey: ["crewGoal", me.data?.id, projectId], queryFn: () => getCrewGoal(projectId),
    enabled: Boolean(me.data?.id),
    staleTime: 60_000, refetchInterval: 60_000, refetchOnReconnect: "always",
  });
  if (!me.data?.id) return null;
  if (goal.isError && typeof goal.error === "object" && goal.error !== null && "code" in goal.error && goal.error.code === "42501") return null;
  if (goal.isPending) return <section className="detail-card" aria-label={t("work.goal.title")}><p role="status">{t("work.goal.loading")}</p></section>;
  if (goal.isError && !goal.data) return <section className="detail-card" aria-label={t("work.goal.title")}><p role="alert">{t("work.goal.unavailable")}</p><button type="button" onClick={() => void goal.refetch()}>{t("work.goal.retry")}</button></section>;
  if (!goal.data) return null;
  const g = goal.data;
  const saved = goal.isError || goal.fetchStatus === "paused" || !navigator.onLine;
  return <section className="detail-card" aria-label={t("work.goal.title")}>
    <h2>{t("work.goal.title")}</h2>
    <p>{t("work.goal.goal")}: {g.goal_hours == null ? t("work.goal.unset") : number(g.goal_hours)}{g.goal_revision != null ? ` · ${t("work.goal.revision")} ${g.goal_revision}` : ""}</p>
    <p>{t("work.goal.recorded")}: {number(g.recorded_hours)}</p>
    <p>{t("work.goal.running")}: {number(g.running_provisional_hours)}</p>
    <p>{t("work.goal.allowance")}: {g.allowance_hours == null ? t("work.goal.unset") : number(g.allowance_hours)}</p>
    <p className="muted">{t("work.goal.counts").replace("{open}", String(g.open_shifts)).replace("{unresolved}", String(g.unresolved_shifts))}</p>
    <p className="muted">{saved ? t("work.goal.saved") : t("work.goal.asOf")} {new Date(g.as_of).toLocaleString()}</p>
    <p className="muted">{t("work.goal.caveat")}</p>
  </section>;
}
