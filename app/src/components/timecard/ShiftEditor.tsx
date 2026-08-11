// The punch add/adjust form, delete flow and edit-history list, shared by
// every timecard surface. Moved out of pages/Timecard.tsx unchanged when the
// page took on the Horizon-style roster/panel split (2026-08-11).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { sendPush } from "../../lib/permissions/pushServer";
import {
  leadAddShift,
  leadEditShift,
  leadVoidShift,
  listShiftEdits,
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
  const [projectId, setProjectId] = useState(shift?.project_id ?? "");
  const [codeId, setCodeId] = useState(shift?.cost_code_id ?? "");
  const [inAt, setInAt] = useState(
    toLocalInput(shift?.clock_in_at ?? defaultInAt ?? new Date().toISOString()),
  );
  const [outAt, setOutAt] = useState(toLocalInput(shift?.clock_out_at ?? null));
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

  const save = useMutation({
    mutationFn: () => {
      const breakSeconds = Math.max(0, Math.round(Number(breakMin) || 0) * 60);
      if (mode === "add") {
        return leadAddShift({
          profileId,
          projectId: projectId || null,
          costCodeId: codeId || null,
          clockInAt: fromLocalInput(inAt)!,
          clockOutAt: fromLocalInput(outAt),
          breakSeconds,
          note: note.trim() || null,
        });
      }
      return leadEditShift(shift!.id, {
        projectId: projectId || null,
        costCodeId: codeId || null,
        clockInAt: fromLocalInput(inAt),
        clockOutAt: fromLocalInput(outAt),
        breakSeconds,
        note: note.trim(),
      });
    },
    onSuccess: () => {
      // Editing an approved shift un-approves it server-side; tell the crew
      // member their numbers changed rather than letting payroll surprise
      // them. Fire-and-forget, same as the approval push.
      if (mode === "edit" && shift?.status === "approved") {
        void sendPush({
          profileIds: [shift.profile_id],
          title: "Timecard adjusted",
          body: "Your approved hours were changed and need re-approval.",
          tag: `timecard-edited-${shift.id}`,
          url: "/clock",
        });
      }
      refresh();
      onDone();
    },
  });

  // Delete = void, never erase: the punch leaves timecards and payroll, the
  // row and the reason stay in the audit log. Same required note as an edit.
  const del = useMutation({
    mutationFn: () => leadVoidShift(shift!.id, note.trim()),
    onSuccess: () => {
      // The crew member should hear it from the app, not from a short check.
      void sendPush({
        profileIds: [shift!.profile_id],
        title: "Timecard punch deleted",
        body: "A punch on your timecard was deleted. Ask your lead if that's a surprise.",
        tag: `timecard-deleted-${shift!.id}`,
        url: "/clock",
      });
      refresh();
      onDone();
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
      <input
        type="datetime-local"
        value={outAt}
        onChange={(e) => setOutAt(e.target.value)}
      />
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
          disabled={save.isPending || !inAt || (mode === "edit" && note.trim() === "")}
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
