// The punch add/adjust form, delete flow and edit-history list, shared by
// every timecard surface. Moved out of pages/Timecard.tsx unchanged when the
// page took on the Horizon-style roster/panel split (2026-08-11).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { getMyProfile } from "../../lib/install/api";
import { sendPush } from "../../lib/permissions/pushServer";
import { changedPunchFields, editPushBody } from "../../lib/timecardNotice";
import { endFromDuration } from "../../lib/shiftGuard";
import { showUndoToast } from "../../lib/undoToast";
import {
  editShift,
  leadAddShift,
  listShiftEdits,
  restoreShift,
  voidShift,
  type TimeShift,
} from "../../lib/timeclock";

/** ISO → value for a <input type="datetime-local"> (viewer local time). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type ProjectOpt = { id: string; job_code: string; name: string };
export type CostOpt = { id: string; code: string; label: string };

/** Inline add/adjust punch form for leads. */
export function ShiftEditor({
  mode,
  shift,
  profileId,
  projects,
  costCodes,
  onDone,
  defaultInAt,
}: {
  mode: "add" | "edit";
  shift: TimeShift | null;
  profileId: string;
  projects: ProjectOpt[];
  costCodes: CostOpt[];
  onDone: () => void;
  /** Prefill for add mode — an empty day's "+ Add" seeds its own date. */
  defaultInAt?: string;
}) {
  const qc = useQueryClient();
  // Whose punch this is, relative to whoever is editing. A supervisor tidying
  // up their OWN timecard should not push themselves a notice about it.
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const isMine = Boolean(me.data?.id) && me.data?.id === profileId;
  const [projectId, setProjectId] = useState(shift?.project_id ?? "");
  const [codeId, setCodeId] = useState(shift?.cost_code_id ?? "");
  const [inAt, setInAt] = useState(
    toLocalInput(shift?.clock_in_at ?? defaultInAt ?? new Date().toISOString()),
  );
  const [outAt, setOutAt] = useState(toLocalInput(shift?.clock_out_at ?? null));
  // T2: "date + start + duration-hours mode computing the end" — an
  // alternative to picking a literal clock-out time. Defaults to the
  // existing picker so nothing changes for anyone who doesn't touch it.
  const [endMode, setEndMode] = useState<"clockOut" | "duration">("clockOut");
  const [durationHours, setDurationHours] = useState("");
  const durationValue = Number(durationHours);
  const durationValid = durationHours.trim() !== "" && Number.isFinite(durationValue) && durationValue >= 0;
  const [breakMin, setBreakMin] = useState(
    String(Math.round((shift?.break_seconds ?? 0) / 60)),
  );
  // Every edit needs its OWN reason (the server refuses without one), so this
  // never prefills from the last edit's note - a stale reason on a new change
  // would be a false audit entry.
  const [note, setNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["teamShifts"] });
    qc.invalidateQueries({ queryKey: ["timecardMine"] });
    qc.invalidateQueries({ queryKey: ["timecardPanel"] });
    qc.invalidateQueries({ queryKey: ["unfinishedShifts"] });
  };

  // Duration mode computes the finish time from the clock-in instead of
  // reading it from a picker — same result fed to the same RPC either way,
  // so the server never knows which mode was used.
  function resolvedClockOutAt(): string | null {
    if (endMode === "clockOut") return fromLocalInput(outAt);
    if (!durationValid) return null;
    const clockInIso = fromLocalInput(inAt);
    return clockInIso ? endFromDuration(clockInIso, durationValue) : null;
  }

  const save = useMutation({
    mutationFn: () => {
      const breakSeconds = Math.max(0, Math.round(Number(breakMin) || 0) * 60);
      const clockOutAt = resolvedClockOutAt();
      if (mode === "add") {
        return leadAddShift({
          profileId,
          projectId: projectId || null,
          costCodeId: codeId || null,
          clockInAt: fromLocalInput(inAt)!,
          clockOutAt,
          breakSeconds,
          note: note.trim() || null,
        });
      }
      return editShift(shift!.id, {
        projectId: projectId || null,
        costCodeId: codeId || null,
        clockInAt: fromLocalInput(inAt),
        clockOutAt,
        breakSeconds,
        note: note.trim(),
      });
    },
    onSuccess: (saved) => {
      // K4: EVERY change to somebody else's punch is told to them, not just
      // the ones that happened to be approved already. The old condition
      // (status === "approved") meant an edit before approval, or a punch
      // added on their behalf, moved their pay in silence. Not mine, though:
      // a supervisor fixing their own punch does not need to push themselves.
      if (!isMine) {
        if (mode === "add") {
          void sendPush({
            profileIds: [profileId],
            title: "Punch added to your timecard",
            body: "A supervisor added a punch for you. Check My timecard.",
            tag: `timecard-added-${saved.id}`,
            url: "/timecard",
          });
        } else if (shift) {
          const fields = changedPunchFields(shift, {
            clock_in_at: saved.clock_in_at,
            clock_out_at: saved.clock_out_at,
            break_seconds: saved.break_seconds,
            project_id: saved.project_id,
            cost_code_id: saved.cost_code_id,
          });
          void sendPush({
            profileIds: [shift.profile_id],
            title: "Timecard adjusted",
            // Both statuses, from the row the server actually returned:
            // edit_shift decides for itself whether the punch keeps its
            // approval, and the push has to report that, not predict it.
            body: editPushBody(fields, shift.status, saved.status),
            tag: `timecard-edited-${shift.id}`,
            url: "/timecard",
          });
        }
      }
      refresh();
      onDone();
    },
  });

  // Delete = void, never erase: the punch leaves timecards and payroll, the
  // row and the reason stay in the audit log. Same required note as an edit.
  // T3: the app-wide five-second Undo toast fires restoreShift — the same
  // RPC the "Show removed" list's own Restore button calls later.
  const del = useMutation({
    mutationFn: () => voidShift(shift!.id, note.trim()),
    onSuccess: () => {
      // The crew member should hear it from the app, not from a short check.
      // Not when it is their own punch, though (K4) — nobody needs a push
      // about the thing they just did.
      if (!isMine) {
        void sendPush({
          profileIds: [shift!.profile_id],
          title: "Timecard punch deleted",
          body: "A punch on your timecard was deleted. Ask your lead if that's a surprise.",
          tag: `timecard-deleted-${shift!.id}`,
          url: "/clock",
        });
      }
      refresh();
      onDone();
      showUndoToast({
        message: "Punch deleted.",
        undo: async () => {
          await restoreShift(shift!.id);
          refresh();
        },
      });
    },
  });

  return (
    <div className="detail-card" style={{ marginTop: 8 }}>
      <label className="field-label">Job</label>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">— no job —</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.job_code} — {p.name}
          </option>
        ))}
      </select>
      <label className="field-label">Cost code</label>
      <select value={codeId} onChange={(e) => setCodeId(e.target.value)}>
        <option value="">— no code —</option>
        {costCodes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} · {c.label}
          </option>
        ))}
      </select>
      <label className="field-label">Clock in</label>
      <input
        type="datetime-local"
        value={inAt}
        onChange={(e) => setInAt(e.target.value)}
      />
      <label className="field-label">Clock out</label>
      <div className="seg" role="tablist" aria-label="How to set the finish time">
        <button
          type="button"
          role="tab"
          aria-selected={endMode === "clockOut"}
          className={endMode === "clockOut" ? "active-pill button-like" : "button-like"}
          onClick={() => setEndMode("clockOut")}
        >
          Pick a time
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={endMode === "duration"}
          className={endMode === "duration" ? "active-pill button-like" : "button-like"}
          onClick={() => setEndMode("duration")}
        >
          Hours worked
        </button>
      </div>
      {endMode === "clockOut" ? (
        <input
          type="datetime-local"
          value={outAt}
          onChange={(e) => setOutAt(e.target.value)}
        />
      ) : (
        <>
          <input
            type="number"
            min={0}
            step={0.25}
            placeholder="e.g. 8.5"
            value={durationHours}
            onChange={(e) => setDurationHours(e.target.value)}
          />
          <p className="muted" style={{ fontSize: 11.5, margin: "4px 0 0" }}>
            {durationValid
              ? `Ends ${new Date(resolvedClockOutAt()!).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}`
              : "Enter the hours worked — the finish time is computed from the clock-in."}
          </p>
        </>
      )}
      <label className="field-label">Break (minutes)</label>
      <input
        type="number"
        min={0}
        value={breakMin}
        onChange={(e) => setBreakMin(e.target.value)}
      />
      <label className="field-label">
        {mode === "edit" ? "Reason (required — goes in the audit log)" : "Note (why adjusted)"}
      </label>
      <input
        type="text"
        value={note}
        placeholder="e.g. forgot to clock out"
        onChange={(e) => setNote(e.target.value)}
      />
      {save.isError && <p className="error">{formatApiError(save.error)}</p>}
      {del.isError && <p className="error">{formatApiError(del.error)}</p>}
      <div className="row-gap" style={{ marginTop: 10 }}>
        <button
          className="button-like active-pill"
          disabled={
            save.isPending ||
            !inAt ||
            (mode === "edit" && note.trim() === "") ||
            (endMode === "duration" && !durationValid)
          }
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : mode === "add" ? "Add punch" : "Save changes"}
        </button>
        <button className="button-like" onClick={onDone} disabled={save.isPending}>
          Cancel
        </button>
        {mode === "edit" && !confirmDelete && (
          <button
            className="button-like"
            style={{ marginLeft: "auto", color: "var(--bad, #e5484d)" }}
            disabled={del.isPending}
            onClick={() => setConfirmDelete(true)}
          >
            Delete punch
          </button>
        )}
      </div>
      {mode === "edit" && confirmDelete && (
        <div className="detail-card" style={{ marginTop: 10 }}>
          <p style={{ margin: 0 }}>
            Delete this punch? It comes off the timecard and payroll totals.
            The record and your reason stay in the audit log, and{" "}
            {shift?.profiles?.display_name ?? "the crew member"} gets notified.
          </p>
          {note.trim() === "" && (
            <p className="warn-text" style={{ margin: "6px 0 0" }}>
              Type the reason above first — a delete needs one, same as an edit.
            </p>
          )}
          <div className="row-gap" style={{ marginTop: 8 }}>
            <button
              className="button-like active-pill"
              disabled={del.isPending || note.trim() === ""}
              onClick={() => del.mutate()}
            >
              {del.isPending ? "Deleting…" : "Delete punch"}
            </button>
            <button
              className="button-like"
              disabled={del.isPending}
              onClick={() => setConfirmDelete(false)}
            >
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A timestamp field's raw value reads better as a local time. */
function fmtEditValue(field: string, v: string | null): string {
  if (v === null) return "—";
  if (field.endsWith("_at")) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    }
  }
  return v;
}

/**
 * The append-only trail behind an "adjusted" badge — supervisor+ only (RLS
 * enforces it; the UI just doesn't offer the button below that). Shifts
 * adjusted before the audit log existed have a stamp but no rows; say so
 * rather than showing an empty list that looks like a bug.
 */
export function ShiftHistory({ shiftId }: { shiftId: string }) {
  const edits = useQuery({
    queryKey: ["shiftEdits", shiftId],
    queryFn: () => listShiftEdits(shiftId),
  });
  if (edits.isLoading) return <p className="muted">Loading history…</p>;
  if (edits.isError) return <p className="error">{formatApiError(edits.error)}</p>;
  const list = edits.data ?? [];
  if (list.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 11.5 }}>
        No logged edits — this punch was adjusted before the audit log existed.
      </p>
    );
  }
  return (
    <ul className="unit-list" style={{ flexBasis: "100%", marginTop: 6 }}>
      {list.map((e) => (
        <li key={e.id} className="muted" style={{ fontSize: 11.5 }}>
          {new Date(e.created_at).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}{" "}
          · {e.editor?.display_name ?? "someone"} · {e.field}:{" "}
          {fmtEditValue(e.field, e.old_value)} → {fmtEditValue(e.field, e.new_value)} ·
          “{e.reason}”
        </li>
      ))}
    </ul>
  );
}
