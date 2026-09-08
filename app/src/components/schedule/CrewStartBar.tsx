import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Clock } from "lucide-react";
import { getMyProfile } from "../../lib/install/api";
import { listMyPublished } from "../../lib/schedule/api";
import { addDaysISO, agendaDayLabel, formatStartTime } from "../../lib/schedule/dates";
import { useT } from "../../lib/i18n";

function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Personal published instructions, visible before clock-in on every landing. */
export function CrewStartBar() {
  const t = useT();
  const [today, setToday] = useState(localDay);
  useEffect(() => {
    const timer = window.setInterval(() => setToday(localDay()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const through = addDaysISO(today, 6);
  const schedule = useQuery({
    queryKey: ["mySchedule", me.data?.id, today, through],
    queryFn: () => listMyPublished(me.data!.id, today, through),
    enabled: Boolean(me.data?.id),
    refetchInterval: 15_000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  const rows = (schedule.data ?? []).filter(a =>
    a.status === "published" && a.end_date >= today && a.start_date <= through &&
    a.members.some(m => m.profile_id === me.data?.id),
  ).sort((a, b) => {
    const dayA = a.start_date < today ? today : a.start_date;
    const dayB = b.start_date < today ? today : b.start_date;
    return dayA.localeCompare(dayB) || (a.start_time ?? "99").localeCompare(b.start_time ?? "99") || a.id.localeCompare(b.id);
  });
  const nextDay = rows[0] ? (rows[0].start_date < today ? today : rows[0].start_date) : null;
  const next = nextDay ? rows.filter(a => a.start_date <= nextDay && a.end_date >= nextDay) : [];
  return (
    <section className="crew-start-bar" aria-label={t("crewStart.label")}>
      <Link to="/my-schedule" className="crew-start-heading">
        <Clock size={16} aria-hidden />
        <strong>{nextDay === today ? t("mywork.today") : nextDay ? agendaDayLabel(nextDay) : t("crewStart.label")}</strong>
        <span>{t("crewStart.view")}</span>
      </Link>
      {schedule.isError || me.isError ? (
        <button type="button" className="crew-start-message" onClick={() => { void me.refetch(); void schedule.refetch(); }}>
          {t("crewStart.retry")}
        </button>
      ) : schedule.isPending || me.isPending ? (
        <p className="crew-start-message">{t("crewStart.loading")}</p>
      ) : next.length === 0 ? (
        <p className="crew-start-message">{t("crewStart.empty")}</p>
      ) : next.map(a => (
        <Link key={a.id} className="crew-start-row" to="/my-schedule">
          <strong className="crew-start-time">{a.start_time ? `${t("crewStart.starts")} ${formatStartTime(a.start_time)}` : t("crewStart.noTime")}</strong>
          <span className="crew-start-project">{a.project?.job_code && `${a.project.job_code} · `}{a.project?.name ?? a.delivery?.label ?? t("mywork.jobToday")}</span>
        </Link>
      ))}
    </section>
  );
}
