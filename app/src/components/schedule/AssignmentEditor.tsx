import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Plane, Trash2, Truck, X } from "lucide-react";
import type { Profile } from "../../lib/install/types";
import type { Project } from "../../lib/types";
import { INSTALLER_PALETTE } from "../../lib/install/mapDispatch";
import { addDaysISO, daysBetween } from "../../lib/schedule/dates";
import { conflictingMembersFor } from "../../lib/schedule/conflicts";
import { removeWarning } from "../../lib/schedule/removeWarning";
import { useFocusTrap } from "../../lib/useFocusTrap";
import type { VehicleWithMeta } from "../../lib/vehicles/types";
import { vehicleSubtitle, vehicleTitle } from "../../lib/vehicles/display";
import {
  isVehicleDoubleBooked,
  type VehicleBooking,
} from "../../lib/vehicles/scheduleConflicts";
import type {
  AssignmentMember,
  CrewMemberRole,
  ScheduleAssignment,
} from "../../lib/schedule/types";

export interface EditorResult {
  project_id: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  color: string | null;
  note: string | null;
  members: AssignmentMember[];
  /** Vehicle/trailer to tie to this block, or null to leave/clear it. */
  vehicle_id: string | null;
}

interface Props {
  /** Existing assignment to edit, or null to create a new one. */
  assignment: ScheduleAssignment | null;
  /** Prefill for a brand-new assignment (day tapped / project from tray). */
  defaults?: { start_date?: string; project_id?: string };
  projects: Project[];
  crew: Profile[];
  /** Other assignments in the loaded window, for the inline conflict warning. */
  others: ScheduleAssignment[];
  /** Crew ids to emphasize (opened from the conflict banner's "Fix"). */
  highlightMemberIds?: string[];
  horizon: { from: string; to: string };
  /** Fleet to pick a vehicle/trailer from (optional). */
  vehicles?: VehicleWithMeta[];
  /** Vehicle already tied to this block (edit mode). */
  currentVehicleId?: string | null;
  /** All existing vehicle bookings, for the double-booking heads-up. */
  vehicleBookings?: VehicleBooking[];
  /** Shown for a published, out-of-town block: opens a prefilled TripEditor. */
  onPlanTravel?: () => void;
  saving?: boolean;
  onSave: (result: EditorResult) => void;
  onDelete?: () => void;
  onClose: () => void;
}

function nameOf(crew: Profile[], id: string): string {
  return crew.find((p) => p.id === id)?.display_name ?? "Crew";
}

export function AssignmentEditor({
  assignment,
  defaults,
  projects,
  crew,
  others,
  highlightMemberIds,
  horizon,
  vehicles,
  currentVehicleId,
  vehicleBookings,
  onPlanTravel,
  saving,
  onSave,
  onDelete,
  onClose,
}: Props) {
  const highlightSet = useMemo(
    () => new Set(highlightMemberIds ?? []),
    [highlightMemberIds],
  );
  const [projectId, setProjectId] = useState(
    assignment?.project_id ?? defaults?.project_id ?? "",
  );
  const [startDate, setStartDate] = useState(
    assignment?.start_date ?? defaults?.start_date ?? horizon.from,
  );
  const [endDate, setEndDate] = useState(
    assignment?.end_date ?? assignment?.start_date ?? defaults?.start_date ?? horizon.from,
  );
  const [startTime, setStartTime] = useState(
    assignment ? (assignment.start_time ?? "") : "06:30",
  );
  const [color, setColor] = useState(assignment?.color ?? "");
  const [note, setNote] = useState(assignment?.note ?? "");
  const [vehicleId, setVehicleId] = useState(currentVehicleId ?? "");
  const vehicleSynced = useRef(currentVehicleId !== undefined);
  useEffect(() => {
    // Adopt the linked vehicle once the (async) lookup resolves, but never
    // clobber a choice the user has already made.
    if (!vehicleSynced.current && currentVehicleId !== undefined) {
      vehicleSynced.current = true;
      setVehicleId(currentVehicleId ?? "");
    }
  }, [currentVehicleId]);
  const [members, setMembers] = useState<AssignmentMember[]>(
    assignment?.members.map((m) => ({ ...m })) ?? [],
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const confirmRef = useRef<HTMLDivElement>(null);
  const cancelDelete = () => setConfirmingDelete(false);
  useFocusTrap(confirmRef, confirmingDelete, cancelDelete);

  const warning = useMemo(
    () =>
      removeWarning({
        status: assignment?.status ?? "draft",
        jobLabel: assignment?.project?.job_code ?? assignment?.project?.name ?? null,
        crewCount: assignment?.members.length ?? 0,
      }),
    [assignment?.status, assignment?.project?.job_code, assignment?.project?.name, assignment?.members.length],
  );

  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = noteRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [note]);

  const foremen = useMemo(
    () => crew.filter((p) => p.active && (p.role === "foreman" || p.role === "supervisor" || p.role === "owner")),
    [crew],
  );
  const installers = useMemo(
    () => crew.filter((p) => p.active),
    [crew],
  );

  const memberIds = new Set(members.map((m) => m.profile_id));

  function toggleMember(profileId: string, role: CrewMemberRole) {
    setMembers((prev) => {
      const existing = prev.find((m) => m.profile_id === profileId);
      if (existing) {
        // Second tap in a different role slot switches the role; same slot removes.
        if (existing.role === role) return prev.filter((m) => m.profile_id !== profileId);
        return prev.map((m) => (m.profile_id === profileId ? { ...m, role } : m));
      }
      return [...prev, { profile_id: profileId, role }];
    });
  }

  const normalizedEnd = daysBetween(startDate, endDate) < 0 ? startDate : endDate;

  const inlineConflicts = useMemo(() => {
    const target = {
      id: assignment?.id ?? "__new__",
      start_date: startDate,
      end_date: normalizedEnd,
      members: members.map((m) => ({ profile_id: m.profile_id })),
    };
    return conflictingMembersFor(target, others);
  }, [assignment?.id, startDate, normalizedEnd, members, others]);

  const canSave = projectId !== "" && members.length > 0 && Boolean(startDate);

  const vehicleClash = useMemo(() => {
    if (!vehicleId) return false;
    return isVehicleDoubleBooked(
      {
        vehicle_id: vehicleId,
        assignment_id: assignment?.id ?? "__new__",
        start_date: startDate,
        end_date: normalizedEnd,
      },
      vehicleBookings ?? [],
    );
  }, [vehicleId, assignment?.id, startDate, normalizedEnd, vehicleBookings]);

  const sortedVehicles = useMemo(
    () =>
      (vehicles ?? [])
        .filter((v) => v.status !== "sold")
        .slice()
        .sort((a, b) => vehicleTitle(a).localeCompare(vehicleTitle(b))),
    [vehicles],
  );

  function submit() {
    if (!canSave) return;
    onSave({
      project_id: projectId,
      start_date: startDate,
      end_date: normalizedEnd,
      start_time: startTime.trim() ? startTime : null,
      color: color || null,
      note: note.trim() ? note.trim() : null,
      members,
      vehicle_id: vehicleId || null,
    });
  }

  return (
    <div className="sched-sheet-backdrop" role="dialog" aria-modal="true">
      <div className="sched-sheet">
        <div className="sched-sheet-head">
          <h2 style={{ margin: 0 }}>{assignment ? "Edit assignment" : "New assignment"}</h2>
          <button className="icon-button sched-sheet-close" onClick={onClose} aria-label="Close">
            <X size={20} strokeWidth={2.5} />
          </button>
        </div>

        <label className="field-label">Job</label>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">— pick a job —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.job_code} — {p.name}
            </option>
          ))}
        </select>

        <div className="sched-row-2">
          <div>
            <label className="field-label">Start</label>
            <input
              type="date"
              value={startDate}
              min={horizon.from}
              max={horizon.to}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (daysBetween(e.target.value, endDate) < 0) setEndDate(e.target.value);
              }}
            />
          </div>
          <div>
            <label className="field-label">End</label>
            <input
              type="date"
              value={normalizedEnd}
              min={startDate}
              max={horizon.to}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>

        <div className="sched-row-2">
          <div>
            <label className="field-label">Start time (optional)</label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label">Quick length</label>
            <div className="row-gap">
              {[1, 3, 5].map((d) => (
                <button
                  key={d}
                  type="button"
                  className="button-like"
                  onClick={() => setEndDate(addDaysISO(startDate, d - 1))}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="field-label">Foremen</label>
        <div className="sched-chips">
          {foremen.map((p) => {
            const picked = members.find((m) => m.profile_id === p.id)?.role === "foreman";
            const clash = highlightSet.has(p.id) && memberIds.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                className={`sched-chip${picked ? " is-picked" : ""}${clash ? " is-clash" : ""}`}
                onClick={() => toggleMember(p.id, "foreman")}
              >
                {p.display_name}
              </button>
            );
          })}
          {foremen.length === 0 && <p className="muted">No foremen on the roster yet.</p>}
        </div>

        <label className="field-label">Installers</label>
        <div className="sched-chips">
          {installers.map((p) => {
            const picked = members.find((m) => m.profile_id === p.id)?.role === "installer";
            const clash = highlightSet.has(p.id) && memberIds.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                className={`sched-chip${picked ? " is-picked" : ""}${clash ? " is-clash" : ""}`}
                onClick={() => toggleMember(p.id, "installer")}
              >
                {p.display_name}
              </button>
            );
          })}
        </div>

        {memberIds.size > 0 && (
          <p className="muted" style={{ fontSize: 12 }}>
            Crew: {members.map((m) => nameOf(crew, m.profile_id)).join(", ")}
          </p>
        )}

        {inlineConflicts.length > 0 && (
          <div
            className={`sched-conflict-inline${highlightSet.size > 0 ? " is-emphasized" : ""}`}
            role="alert"
          >
            <AlertTriangle size={15} aria-hidden />
            <span>
              Double-booked: {inlineConflicts.map((id) => nameOf(crew, id)).join(", ")} already
              on another job in these dates. You can still schedule — just a heads-up.
            </span>
          </div>
        )}

        {sortedVehicles.length > 0 && (
          <>
            <label className="field-label">
              <Truck size={13} aria-hidden /> Vehicle / trailer (optional)
            </label>
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">— no vehicle —</option>
              {sortedVehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {vehicleTitle(v)} · {vehicleSubtitle(v)}
                </option>
              ))}
            </select>
            {vehicleClash && (
              <div className="sched-conflict-inline" role="alert">
                <AlertTriangle size={15} aria-hidden />
                <span>
                  That truck is already booked on another job in these dates. You can still assign
                  it — just a heads-up.
                </span>
              </div>
            )}
          </>
        )}

        {onPlanTravel && (
          <button
            type="button"
            className="button-like"
            style={{ marginTop: 10 }}
            onClick={onPlanTravel}
          >
            <Plane size={15} aria-hidden /> Plan travel for this crew
          </button>
        )}

        <label className="field-label">Color</label>
        <div className="sched-chips">
          <button
            type="button"
            className={`sched-swatch${color === "" ? " is-picked" : ""}`}
            style={{ background: "var(--card-hot)" }}
            onClick={() => setColor("")}
            aria-label="Auto color by crew"
          >
            auto
          </button>
          {INSTALLER_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              className={`sched-swatch${color === c ? " is-picked" : ""}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>

        <label className="field-label">Note (optional)</label>
        <textarea
          ref={noteRef}
          className="sched-note-input"
          rows={2}
          value={note}
          placeholder="e.g. bring the big ladder"
          onChange={(e) => setNote(e.target.value)}
        />

        <div className="sched-sheet-actions">
          {assignment && onDelete && (
            <button
              className="button-like danger-outline"
              onClick={() => setConfirmingDelete(true)}
              disabled={saving}
            >
              <Trash2 size={15} aria-hidden /> Remove
            </button>
          )}
          <button
            className="button-like active-pill"
            style={{ marginLeft: "auto" }}
            onClick={submit}
            disabled={!canSave || saving}
          >
            {saving ? "Saving…" : assignment ? "Save changes" : "Add to draft"}
          </button>
        </div>
        {!canSave && (
          <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            Pick a job and at least one crew member.
          </p>
        )}
      </div>

      {assignment && onDelete && confirmingDelete && (
        <div
          className="sched-sheet-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sched-remove-title"
        >
          <div className="sched-sheet" ref={confirmRef}>
            <div className="sched-sheet-head">
              <h2 id="sched-remove-title" style={{ margin: 0 }}>
                {warning.title}
              </h2>
            </div>
            <div
              className={`sched-conflict-inline${warning.published ? " is-emphasized" : ""}`}
              role="alert"
            >
              <AlertTriangle size={16} aria-hidden />
              <div>
                {warning.lines.map((line, i) => (
                  <p key={i} style={{ margin: i === 0 ? 0 : "6px 0 0" }}>
                    {line}
                  </p>
                ))}
              </div>
            </div>
            <div className="sched-sheet-actions">
              <button className="button-like" onClick={cancelDelete} disabled={saving}>
                Cancel
              </button>
              <button
                className="button-like danger-outline"
                style={{ marginLeft: "auto" }}
                onClick={onDelete}
                disabled={saving}
              >
                <Trash2 size={15} aria-hidden />{" "}
                {saving ? "Removing…" : warning.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
