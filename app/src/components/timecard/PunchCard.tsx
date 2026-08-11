// One punch, Horizon style: card with a left accent rail, job on top, cost
// code under it, mono time range, duration flush right, amber break line
// nested below. All of Infinity's per-punch truth stays on the card — status,
// injury, crew time-flag, reject reason, edit history, runaway warning — and
// the per-punch Approve / Reject / Edit actions live at the bottom edge.

import { useState } from "react";
import { Coffee } from "lucide-react";
import { formatApiError } from "../../lib/errors";
import {
  elapsedWorkSeconds,
  shiftHours,
  type TimeShift,
} from "../../lib/timeclock";
import { describeDuration, needsFinishTime, shiftGuard } from "../../lib/shiftGuard";
import { ShiftEditor, ShiftHistory, type CostOpt, type ProjectOpt } from "./ShiftEditor";
import { fmtHours, fmtTime } from "./format";

interface PunchCardProps {
  shift: TimeShift;
  isLead: boolean;
  isSup: boolean;
  canEdit: boolean;
  projects: ProjectOpt[];
  costCodes: CostOpt[];
  reject: { isPending: boolean; mutate: (args: { id: string; reason: string }) => void; error?: unknown };
}

export function PunchCard({ shift: s, isLead, isSup, canEdit, projects, costCodes, reject }: PunchCardProps) {
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  const voided = s.status === "voided";
  const open = !s.clock_out_at;
  const guard = shiftGuard(s, Date.now());
  const railClass = voided
    ? "tcx-punch voided"
    : s.status === "approved"
      ? "tcx-punch ok"
      : s.status === "rejected"
        ? "tcx-punch bad"
        : "tcx-punch";

  return (
    <div className={railClass}>
      <div className="tcx-punch-main">
        <div className="tcx-punch-head">
          <span className="tcx-punch-job">
            {s.projects?.job_code ?? "No job"}
            {voided && <span className="tcx-chip bad">Deleted</span>}
          </span>
          <span className={`tcx-dur${open && !voided ? " live" : ""}`}>
            {open && !voided
              ? describeDuration(elapsedWorkSeconds(s) | 0)
              : fmtHours(shiftHours(s))}
          </span>
        </div>
        {s.cost_codes && (
          <div className="tcx-punch-code">
            {s.cost_codes.code} · {s.cost_codes.label}
          </div>
        )}
        <div className="tcx-punch-times">
          {fmtTime(s.clock_in_at)} – {open ? "active" : fmtTime(s.clock_out_at)}
        </div>
        {s.break_seconds > 0 && (
          <div className="tcx-break">
            <Coffee size={12} aria-hidden />
            {fmtHours(s.break_seconds / 3600)} on breaks (excluded)
          </div>
        )}

        <div className="tcx-punch-status" style={{ fontSize: 11.5 }}>
          <span className={`tcx-status ${s.status}`}>
            {needsFinishTime(s) ? "needs a finish time" : s.status}
          </span>
          {s.injured && <span className="tcx-chip bad">injury</span>}
          {/* The crew member answered "No" to "is your time correct?" at
              clock-out — the day is theirs to dispute; the office sees it here. */}
          {s.time_confirmed === false && (
            <span className="tcx-chip bad">time flagged by crew</span>
          )}
          {s.edited_by &&
            (isSup ? (
              <button
                className="tcx-chip link"
                onClick={() => setHistoryOpen((v) => !v)}
              >
                adjusted · history
              </button>
            ) : (
              <span className="tcx-chip">adjusted</span>
            ))}
        </div>
        {historyOpen && isSup && <ShiftHistory shiftId={s.id} />}
        {voided && s.edited_note && (
          <div className="muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>
            Removed: “{s.edited_note}”
          </div>
        )}
        {!voided && guard.flagged && (
          <div className="warn-text" style={{ fontSize: 11.5 }}>
            {describeDuration(guard.sinceClockInSeconds)} since clock-in — longer
            than a normal day
          </div>
        )}
        {s.status === "rejected" && s.reject_reason && (
          <div className="error" style={{ fontSize: 11.5 }}>
            “{s.reject_reason}”
          </div>
        )}
        {s.note && (
          <div className="muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>
            Note: {s.note}
          </div>
        )}

        {/* Approval is WEEKLY (owner call, 2026-08-11) — the Approve-week
            button lives on the panel's total card. Reject stays per punch:
            a bad punch is a specific punch. */}
        {isLead && !voided && (
          <div className="row-gap tcx-punch-actions">
            {s.status !== "rejected" && (
              <button
                className="button-like"
                onClick={() => {
                  setRejecting((v) => !v);
                  setRejectReason("");
                }}
              >
                Reject
              </button>
            )}
            <button
              className="button-like"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? "Close" : "Edit"}
            </button>
          </div>
        )}
        {rejecting && (
          <div className="row-gap" style={{ marginTop: 6 }}>
            <input
              type="text"
              style={{ flex: 1 }}
              placeholder="Reason (optional)"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <button
              className="button-like active-pill"
              disabled={reject.isPending}
              onClick={() => {
                reject.mutate({ id: s.id, reason: rejectReason });
                setRejecting(false);
              }}
            >
              Send back
            </button>
          </div>
        )}
        {reject.error != null && (
          <p className="error">{formatApiError(reject.error)}</p>
        )}
        {editing && canEdit && (
          <ShiftEditor
            mode="edit"
            shift={s}
            profileId={s.profile_id}
            projects={projects}
            costCodes={costCodes}
            onDone={() => setEditing(false)}
          />
        )}
      </div>
    </div>
  );
}
