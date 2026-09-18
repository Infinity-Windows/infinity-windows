import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, HeartPulse, Plus, X } from "lucide-react";
import { Link } from "react-router-dom";
import { getMyProfile, getRealProfile } from "../../lib/install/api";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isSupervisorPlus } from "../../lib/install/types";
import { useT } from "../../lib/i18n";
import {
  listTimeOff,
  requestTimeOff,
  reviewTimeOff,
} from "../../lib/timeOff/api";
import {
  localDay,
  timeOffCounts,
  type TimeOffKind,
} from "../../lib/timeOff/model";
import { rangeLengthDays, endOfMonthISO } from "../../lib/schedule/dates";
import { QueryError } from "../ui/States";
import "./timeOff.css";

export function TimeOffPanel({
  team = false,
  compact = false,
}: {
  team?: boolean;
  compact?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const today = localDay();
  const { effectiveRole } = useEffectiveRole();
  const real = useQuery({
    queryKey: ["myRealProfile"],
    queryFn: getRealProfile,
  });
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const canAct = Boolean(me.data?.id && me.data.id === real.data?.id);
  const manager = team && canAct && isSupervisorPlus(effectiveRole);
  const rows = useQuery({
    queryKey: ["timeOff", team ? "team" : me.data?.id],
    refetchInterval: 60_000,
    queryFn: () => listTimeOff(team ? undefined : me.data!.id),
    enabled: !!me.data,
  });
  const [form, setForm] = useState(false);
  const [kind, setKind] = useState<TimeOffKind>("sick");
  const [start, setStart] = useState(today),
    [end, setEnd] = useState(today);
  const [period, setPeriod] = useState("year");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [year, setYear] = useState(today.slice(0, 4));
  const [saved, setSaved] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const refresh = () => {
    for (const root of [
      "timeOff",
      "mySchedule",
      "scheduleAssignments",
      "scheduleCoverage",
      "scheduleDrafts",
    ])
      void qc.invalidateQueries({ queryKey: [root] });
  };
  const save = useMutation({
    mutationFn: async () => {
      const key = JSON.stringify([kind, start, end]);
      if (request.current?.key !== key)
        request.current = { key, id: crypto.randomUUID() };
      await requestTimeOff(request.current.id, kind, start, end);
    },
    onSuccess: () => {
      setForm(false);
      setSaved(true);
      request.current = null;
      refresh();
    },
  });
  const review = useMutation({
    mutationFn: ({
      id,
      status,
    }: {
      id: string;
      status: "approved" | "declined" | "canceled";
    }) => reviewTimeOff(id, status),
    onSuccess: refresh,
  });
  const safeMonth = /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
  const safeYear = /^\d{4}$/.test(year) ? year : today.slice(0, 4);
  const from =
    period === "month"
      ? `${safeMonth}-01`
      : period === "year"
        ? `${safeYear}-01-01`
        : undefined;
  const to =
    period === "month"
      ? endOfMonthISO(`${safeMonth}-01`)
      : period === "year"
        ? `${safeYear}-12-31`
        : undefined;
  const visible = rows.data ?? [];
  const people = team
    ? [...new Set(visible.map((r) => r.profile_id))]
    : me.data
      ? [me.data.id]
      : [];
  const current = visible.filter(
    (r) =>
      r.status === "approved" && r.start_date <= today && r.end_date >= today,
  );
  const pending = visible.filter((r) => r.status === "pending");
  const openForm = (next: TimeOffKind) => {
    setKind(next);
    setStart(today);
    setEnd(today);
    setForm(true);
    setSaved(false);
    save.reset();
  };
  return (
    <section className={`time-off card${compact ? " time-off-compact" : ""}`}>
      <div className="time-off-heading">
        <div>
          <h2>
            <CalendarDays size={20} aria-hidden />
            {t(team ? "timeOff.teamTitle" : "timeOff.title")}
          </h2>
          <p className="muted">{t("timeOff.subtitle")}</p>
        </div>
        {!team && canAct && (
          <div className="time-off-actions">
            <button className="button-like" onClick={() => openForm("sick")}>
              <HeartPulse size={18} />
              {t("timeOff.sickToday")}
            </button>
            <button
              className="button-like"
              onClick={() => openForm("vacation")}
            >
              <Plus size={18} />
              {t("timeOff.add")}
            </button>
          </div>
        )}
      </div>
      {rows.error && (
        <QueryError error={rows.error} onRetry={() => void rows.refetch()} />
      )}
      {saved && (
        <p role="status" className="time-off-success">
          {t(kind === "sick" ? "timeOff.sickSaved" : "timeOff.requestSaved")}
        </p>
      )}
      {current.length > 0 && (
        <div className="time-off-away">
          {current.map((r) => (
            <p key={r.id}>
              <strong>
                {team
                  ? `${r.profiles?.display_name ?? t("timeOff.person")} · `
                  : ""}
                {t(`timeOff.kind.${r.kind}`)}
              </strong>{" "}
              · {r.start_date} – {r.end_date}
            </p>
          ))}
        </div>
      )}
      {form && canAct && (
        <form
          className="time-off-form"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="time-off-heading">
            <h3>{t("timeOff.add")}</h3>
            <button
              type="button"
              aria-label={t("timeOff.close")}
              onClick={() => setForm(false)}
            >
              <X size={20} />
            </button>
          </div>
          <label>
            {t("timeOff.type")}
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as TimeOffKind)}
            >
              {(["sick", "vacation", "other"] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`timeOff.kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="time-off-dates">
            <label>
              {t("timeOff.start")}
              <input
                type="date"
                required
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  if (end < e.target.value) setEnd(e.target.value);
                }}
              />
            </label>
            <label>
              {t("timeOff.end")}
              <input
                type="date"
                required
                min={start}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
          <p className="muted">
            {t("timeOff.calendarDays", {
              n: start && end && end >= start ? rangeLengthDays(start, end) : 0,
            })}
          </p>
          <p>
            {t(kind === "sick" ? "timeOff.sickHelp" : "timeOff.approvalHelp")}
          </p>
          {save.error && <QueryError error={save.error} />}
          <button
            className="primary"
            disabled={
              save.isPending ||
              !start ||
              !end ||
              end < start ||
              rangeLengthDays(start, end) > 366
            }
          >
            {t(
              save.isPending
                ? "timeOff.saving"
                : kind === "sick"
                  ? "timeOff.report"
                  : "timeOff.submit",
            )}
          </button>
        </form>
      )}
      {team && pending.length > 0 && (
        <div className="time-off-requests">
          <h3>{t("timeOff.pending")}</h3>
          {pending.map((r) => (
            <article key={r.id} className="time-off-row">
              <div>
                <strong>
                  {r.profiles?.display_name ?? t("timeOff.person")}
                </strong>
                <p>
                  {t(`timeOff.kind.${r.kind}`)} · {r.start_date} – {r.end_date}
                </p>
              </div>
              {manager && (
                <div className="time-off-actions">
                  <button
                    className="primary"
                    disabled={review.isPending}
                    onClick={() =>
                      review.mutate({ id: r.id, status: "approved" })
                    }
                  >
                    {t("timeOff.approve")}
                  </button>
                  <button
                    disabled={review.isPending}
                    onClick={() =>
                      review.mutate({ id: r.id, status: "declined" })
                    }
                  >
                    {t("timeOff.decline")}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {review.error && <QueryError error={review.error} />}
      {!compact && (
        <details className="time-off-details" open={!team}>
          <summary>{t("timeOff.details")}</summary>
          <div className="time-off-filters">
            <label>
              {t("timeOff.counts")}
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              >
                <option value="month">{t("timeOff.month")}</option>
                <option value="year">{t("timeOff.year")}</option>
                <option value="all">{t("timeOff.all")}</option>
              </select>
            </label>
            {period === "month" && (
              <label>
                {t("timeOff.month")}
                <input
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                />
              </label>
            )}
            {period === "year" && (
              <label>
                {t("timeOff.year")}
                <input
                  type="number"
                  min="2020"
                  max="2100"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                />
              </label>
            )}
          </div>
          <p className="muted">{t("timeOff.countHelp")}</p>
          {people.map((id) => {
            const own = visible.filter((r) => r.profile_id === id);
            const count = timeOffCounts(own, today, from, to);
            return (
              <div key={id} className="time-off-person">
                {team && (
                  <h3>
                    {own[0]?.profiles?.display_name ?? t("timeOff.person")}
                  </h3>
                )}
                <div className="time-off-counts">
                  {(["sick", "vacation", "other"] as const).map((k) => (
                    <div key={k}>
                      <span>{t(`timeOff.kind.${k}`)}</span>
                      <strong>{count.taken[k]}</strong>
                      <small>
                        {t("timeOff.planned", { n: count.planned[k] })}
                      </small>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          <details className="time-off-history" open={!team}>
            <summary>{t("timeOff.history")}</summary>
            {visible.length === 0 && (
              <p className="muted">{t("timeOff.empty")}</p>
            )}
            {visible.map((r) => (
              <article className="time-off-row" key={r.id}>
                <div>
                  {team && (
                    <strong>
                      {r.profiles?.display_name ?? t("timeOff.person")} ·{" "}
                    </strong>
                  )}
                  <strong>{t(`timeOff.kind.${r.kind}`)}</strong>
                  <p>
                    {r.start_date} – {r.end_date}
                  </p>
                  <span className={`time-off-status is-${r.status}`}>
                    {t(`timeOff.status.${r.status}`)}
                  </span>
                </div>
                {canAct &&
                  (r.profile_id === me.data?.id || manager) &&
                  ["pending", "approved"].includes(r.status) && (
                    <button
                      disabled={review.isPending}
                      onClick={() =>
                        review.mutate({ id: r.id, status: "canceled" })
                      }
                    >
                      {t("timeOff.cancel")}
                    </button>
                  )}
              </article>
            ))}
          </details>
        </details>
      )}
      {compact && <Link to="/my-schedule">{t("timeOff.details")}</Link>}
    </section>
  );
}
