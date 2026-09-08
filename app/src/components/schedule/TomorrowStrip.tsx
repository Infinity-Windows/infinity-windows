// The Tomorrow line + week chips (S6) — the next published assignment after
// today, on all three landings (My Work, Home, Heartbeat), reading the
// signed-in person's OWN schedule everywhere it mounts. Self-contained, same
// pattern as ClockInBlock/LiveSummonsStrip: it fetches its own profile under
// the same ["myProfile"] key those already use, so mounting it beside them
// costs nothing extra — react-query dedupes the read.
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getMyProfile, listMyOpeningsAllJobs } from "../../lib/install/api";
import { listMyPublished } from "../../lib/schedule/api";
import { addDaysISO, formatScheduleTime } from "../../lib/schedule/dates";
import {
  nextPublishedAfter,
  tomorrowLineParts,
  weekChips,
} from "../../lib/schedule/tomorrow";
import { listVehicleLinksForAssignments } from "../../lib/vehicles/api";
import { vehicleTitle } from "../../lib/vehicles/display";
import { Field } from "../ui/Field";
import { useT } from "../../lib/i18n";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Mon" / "Tue" … — the day/locale helper the rest of the schedule board
 * uses (dates.ts's agendaDayLabel), not a new one: browser locale, UTC noon
 * math so DST never shifts the label a day. */
function weekdayShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: "short",
    timeZone: "UTC",
  });
}

export function TomorrowStrip() {
  const t = useT();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const profileId = me.data?.id ?? null;
  const todayISO = todayLocalISO();
  const toISO = addDaysISO(todayISO, 7);

  const upcoming = useQuery({
    queryKey: ["myScheduleTomorrow", profileId, todayISO, toISO],
    queryFn: () => listMyPublished(profileId!, todayISO, toISO),
    enabled: Boolean(profileId),
  });
  const openings = useQuery({
    queryKey: ["myOpenings", profileId],
    queryFn: () => listMyOpeningsAllJobs(profileId!),
    enabled: Boolean(profileId),
  });

  const rows = upcoming.data ?? [];
  const next = nextPublishedAfter(rows, todayISO);
  const chips = weekChips(rows, todayISO);

  const vehicles = useQuery({
    queryKey: ["myScheduleVehicles", next ? [next.id] : []],
    queryFn: () => listVehicleLinksForAssignments([next!.id]),
    enabled: Boolean(next),
  });
  const truckLink = (vehicles.data ?? []).find((l) => l.vehicle);
  const truckLabel = truckLink?.vehicle ? vehicleTitle(truckLink.vehicle) : null;

  const unitCount = next
    ? (openings.data ?? []).filter(
        (o) => o.project_id === next.project_id && o.status !== "installed",
      ).length
    : 0;

  const parts = next && profileId
    ? tomorrowLineParts(next, profileId, truckLabel, unitCount)
    : null;

  const othersLabel =
    parts && parts.othersCount > 0
      ? t(
          parts.othersCount === 1
            ? "tomorrow.withOthers.one"
            : "tomorrow.withOthers.many",
          { n: parts.othersCount },
        )
      : null;
  const unitsLabel = parts
    ? t(parts.unitCount === 1 ? "tomorrow.units.one" : "tomorrow.units.many", {
        n: parts.unitCount,
      })
    : null;
  const startLabel = parts?.startTime ? formatScheduleTime(parts.startTime, parts.endTime) : null;

  return (
    <section className="tomorrow-strip" aria-label={t("tomorrow.kicker")}>
      <button
        type="button"
        className="tomorrow-line"
        onClick={() => navigate("/my-schedule")}
      >
        <span className="tomorrow-line-main">
          <span className="tomorrow-line-kicker">{t("tomorrow.kicker")}</span>
          {parts ? (
            <span className="tomorrow-line-text">
              {parts.jobLabel}
              {startLabel && (
                <>
                  {" · "}
                  <Field label={t("tomorrow.field.starts")} value={startLabel} inline />
                </>
              )}
              {parts.truckLabel && (
                <>
                  {" · "}
                  <Field label={t("tomorrow.field.truck")} value={parts.truckLabel} inline />
                </>
              )}
              {othersLabel && <> {" · " + othersLabel}</>}
              {unitsLabel && <> {" · " + unitsLabel}</>}
            </span>
          ) : (
            <span className="tomorrow-line-text muted">
              {t("tomorrow.notScheduled")}
            </span>
          )}
        </span>
        <span className="tomorrow-line-arrow" aria-hidden>
          ›
        </span>
      </button>
      <div className="week-chips" role="list" aria-label={t("tomorrow.weekAria")}>
        {chips.map((c) => (
          <span
            key={c.dateISO}
            role="listitem"
            className={`week-chip${c.isToday ? " week-chip--today" : ""}`}
          >
            {weekdayShort(c.dateISO)}
            {c.hasWork && <i className="week-chip-dot" aria-hidden />}
          </span>
        ))}
      </div>
    </section>
  );
}
