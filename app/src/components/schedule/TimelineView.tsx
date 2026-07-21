import { useEffect, useMemo, useRef, useState } from "react";
import {
  daysBetween,
  enumerateDays,
  shortDayLabel,
} from "../../lib/schedule/dates";
import { assignmentColor } from "../../lib/schedule/color";
import { barGeometry, laneCount, packLanes } from "../../lib/schedule/gantt";
import {
  visibleColumnRange,
  visibleRowRange,
  windowDayCount,
} from "../../lib/schedule/window";
import type { ScheduleAssignment } from "../../lib/schedule/types";

interface ProjectRow {
  id: string;
  label: string;
  items: ScheduleAssignment[];
}

interface Props {
  from: string;
  to: string;
  todayISO: string;
  assignments: ScheduleAssignment[];
  conflictIds: Set<string>;
  onOpen: (a: ScheduleAssignment) => void;
}

const COL_WIDTH = 44;
const ROW_HEIGHT = 60;
const LABEL_WIDTH = 128;
const MAX_LANES = 3;

export function TimelineView({
  from,
  to,
  todayISO,
  assignments,
  conflictIds,
  onOpen,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [viewport, setViewport] = useState({ width: 800, height: 420 });

  const totalDays = windowDayCount(from, to);
  const days = useMemo(() => enumerateDays(from, to), [from, to]);

  const rows: ProjectRow[] = useMemo(() => {
    const byProject = new Map<string, ScheduleAssignment[]>();
    for (const a of assignments) {
      const list = byProject.get(a.project_id) ?? [];
      list.push(a);
      byProject.set(a.project_id, list);
    }
    return [...byProject.entries()]
      .map(([id, items]) => ({
        id,
        label:
          items[0].project?.job_code ??
          items[0].project?.name ??
          "Job",
        items,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [assignments]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () =>
      setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const cols = visibleColumnRange(scroll.left, viewport.width, COL_WIDTH, totalDays);
  const rowWin = visibleRowRange(scroll.top, viewport.height, ROW_HEIGHT, rows.length);

  const gridWidth = totalDays * COL_WIDTH;
  const todayCol = daysBetween(from, todayISO);
  const todayInRange = todayCol >= 0 && todayCol < totalDays;

  return (
    <div
      className="sched-timeline"
      ref={scrollRef}
      onScroll={(e) =>
        setScroll({ left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop })
      }
    >
      <div
        className="sched-timeline-inner"
        style={{ width: gridWidth + LABEL_WIDTH, height: rows.length * ROW_HEIGHT + 34 }}
      >
        {/* Sticky day-header row — only the visible columns are rendered. */}
        <div className="sched-timeline-header" style={{ paddingLeft: LABEL_WIDTH }}>
          {days.slice(cols.startIndex, cols.endIndex + 1).map((day, i) => {
            const idx = cols.startIndex + i;
            return (
              <span
                key={day}
                className={`sched-tl-daycell${day === todayISO ? " is-today" : ""}`}
                style={{ left: LABEL_WIDTH + idx * COL_WIDTH, width: COL_WIDTH }}
              >
                {shortDayLabel(day)}
              </span>
            );
          })}
        </div>

        {/* Column gridlines via CSS background so we never mount N day cells. */}
        <div
          className="sched-timeline-grid"
          style={{
            left: LABEL_WIDTH,
            width: gridWidth,
            top: 34,
            height: rows.length * ROW_HEIGHT,
            backgroundSize: `${COL_WIDTH}px ${ROW_HEIGHT}px`,
          }}
        />

        {todayInRange && (
          <div
            className="sched-timeline-today"
            style={{
              left: LABEL_WIDTH + todayCol * COL_WIDTH,
              top: 34,
              height: rows.length * ROW_HEIGHT,
            }}
          />
        )}

        {/* Only the visible rows are mounted. */}
        {rows.slice(rowWin.startIndex, rowWin.endIndex + 1).map((row, i) => {
          const rowIndex = rowWin.startIndex + i;
          const bars = packLanes(row.items);
          const lanes = Math.min(MAX_LANES, Math.max(1, laneCount(bars)));
          const barH = (ROW_HEIGHT - 12) / lanes;
          return (
            <div
              key={row.id}
              className="sched-timeline-row"
              style={{ top: 34 + rowIndex * ROW_HEIGHT, height: ROW_HEIGHT }}
            >
              <span className="sched-tl-rowlabel" style={{ width: LABEL_WIDTH }}>
                {row.label}
              </span>
              <div className="sched-tl-track" style={{ left: LABEL_WIDTH, width: gridWidth }}>
                {bars.map(({ item, lane }) => {
                  if (lane >= MAX_LANES) return null;
                  const geo = barGeometry(item.start_date, item.end_date, from, totalDays, COL_WIDTH);
                  if (!geo) return null;
                  // Viewport cull: skip bars fully outside the visible columns.
                  if (geo.endCol < cols.startIndex || geo.startCol > cols.endIndex) return null;
                  const cls = [
                    "sched-tl-bar",
                    item.status === "draft" ? "is-draft" : "is-published",
                    conflictIds.has(item.id) ? "is-conflict" : "",
                    geo.clippedStart ? "clip-start" : "",
                    geo.clippedEnd ? "clip-end" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <button
                      key={item.id}
                      className={cls}
                      style={{
                        left: geo.left,
                        width: geo.width - 3,
                        top: 6 + lane * barH,
                        height: barH - 3,
                        background: assignmentColor(item),
                      }}
                      onClick={() => onOpen(item)}
                    >
                      <span className="sched-tl-bar-label">
                        {item.project?.name ?? item.project?.job_code ?? "Job"} ·{" "}
                        {item.members.length}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {rows.length === 0 && (
          <p className="muted" style={{ position: "absolute", top: 60, left: LABEL_WIDTH }}>
            No assignments in this range yet.
          </p>
        )}
      </div>
    </div>
  );
}
