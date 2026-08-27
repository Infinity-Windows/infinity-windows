// The crew board: Horizon's week grid over Infinity's schedule blocks.
//
// Rows are people (foremen banded first) or jobs — one toggle, same data.
// Chips are jobs in the block's own color; drafts render dashed exactly like
// the calendar views, published solid. Board edits draw ONLY on drafts:
//   • a chip from a SINGLE-DAY DRAFT drags freely (desktop) or moves via the
//     tap sheet (phone) — and everything the board creates is one of those,
//     so board-native planning is fully fluid;
//   • a chip from a multi-day block or a published row opens the block
//     editor instead — the surface that already knows how to split, edit,
//     and (on publish) notify only the people whose days changed.
// Every board mutation reports an inverse op upward so the page can offer
// one-tap Undo.

import { useMemo, useState } from "react";
import type { Profile } from "../../lib/install/types";
import type { ScheduleAssignment } from "../../lib/schedule/types";
import {
  boardChips,
  chipsByPersonDay,
  chipsByProjectDay,
  type BoardChip,
  type BoardLane,
} from "../../lib/schedule/board";
import { calendarColorStyle } from "../../lib/schedule/jobHue";

export interface ChipMove {
  chip: BoardChip;
  toDay: string;
  toPersonId: string;
}

interface CrewBoardProps {
  weekDays: string[];
  lanes: BoardLane[];
  assignments: ScheduleAssignment[];
  jobCodeById: Map<string, string>;
  profileById: Map<string, Profile>;
  conflictIds: Set<string>;
  canEdit: boolean;
  onMoveChip: (move: ChipMove) => void;
  onRemoveChip: (chip: BoardChip) => void;
  onCreateAt: (personId: string, day: string) => void;
  onOpenAssignment: (assignmentId: string) => void;
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function dayHeader(iso: string, i: number): string {
  return `${DAY_LABELS[i]} ${Number(iso.slice(8, 10))}`;
}

export function CrewBoard({
  weekDays,
  lanes,
  assignments,
  jobCodeById,
  profileById,
  conflictIds,
  canEdit,
  onMoveChip,
  onRemoveChip,
  onCreateAt,
  onOpenAssignment,
}: CrewBoardProps) {
  const [pivot, setPivot] = useState<"crew" | "job">("crew");
  /** The chip a phone tap selected — the move sheet's subject. */
  const [sheetChip, setSheetChip] = useState<BoardChip | null>(null);
  const [sheetDay, setSheetDay] = useState("");
  const [sheetPerson, setSheetPerson] = useState("");
  const [dragChip, setDragChip] = useState<BoardChip | null>(null);

  const byId = useMemo(
    () => new Map(assignments.map((a) => [a.id, a])),
    [assignments],
  );
  const chips = useMemo(() => boardChips(assignments, weekDays), [assignments, weekDays]);
  const crewCells = useMemo(() => chipsByPersonDay(chips), [chips]);
  const jobCells = useMemo(() => chipsByProjectDay(chips), [chips]);

  // Job lanes: every project with a chip this week, by code.
  const jobLanes = useMemo(() => {
    const ids = [...new Set(chips.map((c) => c.projectId))];
    return ids
      .map((id) => ({ id, code: jobCodeById.get(id) ?? "job" }))
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [chips, jobCodeById]);

  /** Only a single-day DRAFT moves on the board; the rest go to the editor. */
  const chipDraggable = (c: BoardChip): boolean => {
    if (!canEdit || c.status !== "draft") return false;
    const a = byId.get(c.assignmentId);
    return Boolean(a && a.start_date === a.end_date);
  };

  const openSheet = (c: BoardChip) => {
    setSheetChip(c);
    setSheetDay(c.day);
    setSheetPerson(c.personId);
  };

  const chipEl = (c: BoardChip, label: string) => {
    const a = byId.get(c.assignmentId);
    const movable = chipDraggable(c);
    return (
      <button
        key={`${c.assignmentId}|${c.personId}|${c.day}`}
        type="button"
        draggable={movable}
        onDragStart={(e) => {
          if (!movable) return e.preventDefault();
          setDragChip(c);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => setDragChip(null)}
        onClick={() => (movable ? openSheet(c) : onOpenAssignment(c.assignmentId))}
        className={[
          "cb-chip",
          c.status === "draft" ? "draft" : "published",
          conflictIds.has(c.assignmentId) ? "conflict" : "",
          movable ? "movable" : "",
        ].join(" ")}
        style={a ? calendarColorStyle(a) : undefined}
        title={
          movable
            ? "Tap to move · drag on desktop"
            : "Part of a block — opens the editor"
        }
      >
        {label}
      </button>
    );
  };

  const dropCell = (personId: string, day: string, children: React.ReactNode) => (
    <td
      key={day}
      className="cb-cell"
      onDragOver={(e) => {
        if (dragChip) e.preventDefault();
      }}
      onDrop={() => {
        if (!dragChip) return;
        if (dragChip.day !== day || dragChip.personId !== personId) {
          onMoveChip({ chip: dragChip, toDay: day, toPersonId: personId });
        }
        setDragChip(null);
      }}
    >
      {children}
      {canEdit && (
        <button
          type="button"
          className="cb-plus"
          aria-label={`Schedule ${profileById.get(personId)?.display_name ?? "someone"} on ${day}`}
          onClick={() => onCreateAt(personId, day)}
        >
          +
        </button>
      )}
    </td>
  );

  return (
    <div className="cb-wrap">
      <div className="cb-toolbar">
        <div className="seg" role="group" aria-label="Board pivot">
          <button
            aria-pressed={pivot === "crew"}
            className={pivot === "crew" ? "active-pill button-like" : "button-like"}
            onClick={() => setPivot("crew")}
          >
            By crew
          </button>
          <button
            aria-pressed={pivot === "job"}
            className={pivot === "job" ? "active-pill button-like" : "button-like"}
            onClick={() => setPivot("job")}
          >
            By job
          </button>
        </div>
        {!canEdit && (
          <span className="muted" style={{ fontSize: 12 }}>
            View only — scheduling changes are a supervisor call.
          </span>
        )}
      </div>

      <div className="cb-scroll">
        <table className="cb-board">
          <thead>
            <tr>
              <th />
              {weekDays.map((d, i) => (
                <th key={d}>{dayHeader(d, i)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pivot === "crew"
              ? lanes.map((lane) => (
                  <tr key={lane.personId}>
                    <td className="cb-lane">
                      {lane.name}
                      {lane.isLead && (
                        <span className="cb-disc">
                          {(profileById.get(lane.personId)?.role ?? "foreman").toUpperCase()}
                        </span>
                      )}
                    </td>
                    {weekDays.map((day) =>
                      dropCell(
                        lane.personId,
                        day,
                        (crewCells.get(`${lane.personId}|${day}`) ?? []).map((c) =>
                          chipEl(c, jobCodeById.get(c.projectId) ?? "job"),
                        ),
                      ),
                    )}
                  </tr>
                ))
              : jobLanes.map((jl) => (
                  <tr key={jl.id}>
                    <td className="cb-lane">{jl.code}</td>
                    {weekDays.map((day) => (
                      <td key={day} className="cb-cell">
                        {(jobCells.get(`${jl.id}|${day}`) ?? []).map((c) =>
                          chipEl(
                            c,
                            profileById.get(c.personId)?.display_name ?? "crew",
                          ),
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
            {pivot === "crew" && lanes.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ padding: 12 }}>
                  No active crew on the roster yet.
                </td>
              </tr>
            )}
            {pivot === "job" && jobLanes.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ padding: 12 }}>
                  Nothing scheduled this week — tap a + in the crew pivot to start.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* The phone's answer to drag — and a keyboard answer too. */}
      {sheetChip && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setSheetChip(null)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 700 }}>
              {jobCodeById.get(sheetChip.projectId) ?? "Job"} ·{" "}
              {profileById.get(sheetChip.personId)?.display_name ?? "crew"}
            </p>
            <label className="field-label">Day</label>
            <input
              type="date"
              value={sheetDay}
              onChange={(e) => setSheetDay(e.target.value)}
            />
            <label className="field-label">Person</label>
            <select value={sheetPerson} onChange={(e) => setSheetPerson(e.target.value)}>
              {[...profileById.values()]
                .filter((p) => p.active)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
            </select>
            <div className="row-gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
              <button
                className="button-like active-pill"
                onClick={() => {
                  if (sheetDay && sheetPerson) {
                    onMoveChip({ chip: sheetChip, toDay: sheetDay, toPersonId: sheetPerson });
                  }
                  setSheetChip(null);
                }}
              >
                Move
              </button>
              <button
                className="button-like"
                onClick={() => {
                  onRemoveChip(sheetChip);
                  setSheetChip(null);
                }}
              >
                Remove
              </button>
              <button className="button-like" onClick={() => setSheetChip(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
