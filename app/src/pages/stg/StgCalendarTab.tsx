// Wave S, S4: the STG "Calendar" tab — a simple own month grid fed by
// stg_calendar (deliberately NOT the crew Scheduling board: a builder needs
// "when is my crew here / when does my truck arrive", not drag-and-drop
// assignment editing). Every granted job's markers share one grid, tinted
// by jobHue.ts's stable per-job hue so a builder with more than one job can
// tell them apart at a glance.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { QueryError, SkeletonCard } from "../../components/ui/States";
import { stgCalendar, stgJobList, type StgCalendarEntry } from "../../lib/stg";
import { localDateISO } from "../../lib/dailyLogDay";
import { jobHue } from "./jobHue";
import { StgDayPanel } from "./StgDayPanel";

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

/** Every visible cell of a Sunday-first month grid, including the leading
 * and trailing days that round it out to full weeks. */
function monthCells(year: number, month: number): { date: string; inMonth: boolean }[] {
  const first = new Date(year, month, 1);
  const startOffset = first.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells: { date: string; inMonth: boolean }[] = [];
  for (let i = 0; i < startOffset; i++) {
    const d = daysInPrevMonth - startOffset + 1 + i;
    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    cells.push({ date: isoDate(prevYear, prevMonth, d), inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: isoDate(year, month, d), inMonth: true });
  }
  while (cells.length % 7 !== 0) {
    const last = cells[cells.length - 1].date;
    const [y, m, d] = last.split("-").map(Number);
    const next = new Date(y, m - 1, d + 1);
    cells.push({
      date: isoDate(next.getFullYear(), next.getMonth(), next.getDate()),
      inMonth: false,
    });
  }
  return cells;
}

/** Every distinct project with any marker touching this date — a worked/
 * delivery marker landing exactly on it, or an install window spanning it. */
function projectsOnDate(entries: StgCalendarEntry[], date: string): string[] {
  const ids = new Set<string>();
  for (const e of entries) {
    if ((e.kind === "worked" || e.kind === "delivery") && e.on_date === date) {
      ids.add(e.project_id);
    } else if (e.kind === "window" && e.from_date && e.to_date && date >= e.from_date && date <= e.to_date) {
      ids.add(e.project_id);
    }
  }
  return [...ids];
}

export function StgCalendarTab() {
  const today = localDateISO();
  const [ym, setYm] = useState(() => {
    const [y, m] = today.split("-").map(Number);
    return { year: y, month: m - 1 };
  });
  const [dayPanel, setDayPanel] = useState<{ projectId: string; jobName: string; date: string } | null>(null);
  const [chooserDate, setChooserDate] = useState<string | null>(null);

  const cells = useMemo(() => monthCells(ym.year, ym.month), [ym.year, ym.month]);
  const rangeFrom = cells[0].date;
  const rangeTo = cells[cells.length - 1].date;

  const jobs = useQuery({ queryKey: ["stgJobList"], queryFn: stgJobList });
  const calendar = useQuery({
    queryKey: ["stgCalendar", rangeFrom, rangeTo],
    queryFn: () => stgCalendar(rangeFrom, rangeTo),
  });

  const jobName = (id: string) => jobs.data?.find((j) => j.id === id)?.name ?? "This job";

  const openDay = (date: string) => {
    const ids = projectsOnDate(calendar.data ?? [], date);
    const targets = ids.length > 0 ? ids : jobs.data?.length === 1 ? [jobs.data[0].id] : [];
    if (targets.length === 0) return;
    if (targets.length === 1) {
      setDayPanel({ projectId: targets[0], jobName: jobName(targets[0]), date });
    } else {
      setChooserDate(date);
    }
  };

  const monthLabel = new Date(ym.year, ym.month, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 10 }}>
        <button
          type="button"
          className="button-like"
          aria-label="Previous month"
          onClick={() => setYm((v) => (v.month === 0 ? { year: v.year - 1, month: 11 } : { year: v.year, month: v.month - 1 }))}
        >
          <ChevronLeft size={16} />
        </button>
        <strong>{monthLabel}</strong>
        <button
          type="button"
          className="button-like"
          aria-label="Next month"
          onClick={() => setYm((v) => (v.month === 11 ? { year: v.year + 1, month: 0 } : { year: v.year, month: v.month + 1 }))}
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {calendar.isError && <QueryError error={calendar.error} onRetry={() => calendar.refetch()} />}
      {calendar.isLoading && <SkeletonCard height={260} />}

      {!calendar.isLoading && (
        <div className="stg-cal-grid">
          {WEEKDAY_LABELS.map((w, i) => (
            <div key={`h${i}`} className="stg-cal-weekday">{w}</div>
          ))}
          {cells.map(({ date, inMonth }) => {
            const ids = projectsOnDate(calendar.data ?? [], date);
            return (
              <button
                type="button"
                key={date}
                className="stg-cal-cell"
                data-in-month={inMonth}
                data-today={date === today}
                onClick={() => openDay(date)}
              >
                <span className="stg-cal-daynum">{Number(date.slice(-2))}</span>
                {ids.length > 0 && (
                  <span className="stg-cal-dots">
                    {ids.slice(0, 4).map((id) => (
                      <span
                        key={id}
                        className="stg-cal-dot"
                        style={{ background: `hsl(${jobHue(id)}, 60%, 50%)` }}
                      />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {chooserDate && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setChooserDate(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ fontSize: 16, marginTop: 0 }}>Which job?</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {projectsOnDate(calendar.data ?? [], chooserDate).map((id) => (
                <button
                  key={id}
                  type="button"
                  className="button-like"
                  style={{ justifyContent: "flex-start" }}
                  onClick={() => {
                    setDayPanel({ projectId: id, jobName: jobName(id), date: chooserDate });
                    setChooserDate(null);
                  }}
                >
                  <span className="stg-cal-dot" style={{ background: `hsl(${jobHue(id)}, 60%, 50%)`, marginRight: 8 }} />
                  {jobName(id)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {dayPanel && (
        <StgDayPanel
          projectId={dayPanel.projectId}
          jobName={dayPanel.jobName}
          date={dayPanel.date}
          onClose={() => setDayPanel(null)}
        />
      )}
    </div>
  );
}
