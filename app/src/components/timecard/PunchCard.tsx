// One punch, Horizon style: card with a left accent rail, job on top, cost
// code under it, mono time range, duration flush right, amber break line
// nested below. All of Infinity's per-punch truth stays on the card — status,
// injury, crew time-flag, reject reason, edit history, runaway warning — and
// the per-punch Approve / Reject / Edit actions live at the bottom edge.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Coffee } from "lucide-react";
import { formatApiError } from "../../lib/errors";
import {
  elapsedWorkSeconds,
  restoreShift,
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
  projects: ProjectOpt[];
  costCodes: CostOpt[];
  reject: { isPending: boolean; mutate: (args: { id: string; reason: string }) => void; error?: unknown };
}

export function PunchCard({ shift: s, isLead, isSup, projects, costCodes, reject }: PunchCardProps) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  // T3: the persistent restore path for the "Show removed" list, once the
  // five-second Undo toast on the delete itself has already expired.
  const restore = useMutation({
    mutationFn: () => restoreShift(s.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teamShifts"] });
      qc.invalidateQueries({ queryKey: ["timecardMine"] });
      qc.invalidateQueries({ queryKey: ["timecardPanel"] });
      qc.invalidateQueries({ queryKey: ["unfinishedShifts"] });
    },
  });

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
        {/* T4: the server closed this one on its own, not the person. */}
        {!voided && s.closed_reason && (
          <div className="muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>
            {s.closed_reason === "auto-closed by next clock-in"
              ? "Auto-closed when the next shift started"
              : s.closed_reason}
          </div>
        )}

        <div className="tcx-punch-status" style={{ fontSize: 11.5 }}>
          <span className={`tcx-status ${s.status}`}>
            {needsFinishTime(s) ? "needs a finish time" : s.status}
          </span>
          {s.injured && <span className="tcx-chip bad">injury</span>}
          {s.injured && s.injury_note && (
            <span className="muted" style={{ fontSize: 12 }}>
              &ldquo;{s.injury_note}&rdquo;
            </span>
          )}
          {/* The crew member answered "No" to "is your time correct?" at
              clock-out — the day is theirs to dispute; the office sees it here. */}
          {s.time_confirmed === false && (
            <span className="tcx-chip bad">time flagged by crew</span>
          )}
          {/* Q3/T2: "edited by <name>" on the row itself, muted — not just a
              generic "adjusted" flag. Supervisors get the same line as a
              button that opens the full per-field history. */}
          {s.edited_by &&
            (isSup ? (
              <button
                className="tcx-chip link"
                onClick={() => setHistoryOpen((v) => !v)}
              >
                edited by {s.editor?.display_name ?? "someone"} · history
              </button>
            ) : (
              // .tcx-chip is muted-colored by default (index.css) — exactly
              // the "edited by <name>" muted line T2 asked for.
              <span className="tcx-chip">
                edited by {s.editor?.display_name ?? "someone"}
              </span>
            ))}
        </div>
        {historyOpen && isSup && <ShiftHistory shiftId={s.id} />}
        {voided && (
          <div className="muted" style={{ fontSize: 11.5 }}>
            <span style={{ fontStyle: "italic" }}>
              Removed{s.voider?.display_name ? ` by ${s.voider.display_name}` : ""}
              {(s.voided_reason ?? s.edited_note) &&
                `: “${s.voided_reason ?? s.edited_note}”`}
            </span>
            {isSup && (
              <button
                className="button-like"
                style={{ marginLeft: 8, fontSize: 11, padding: "1px 8px" }}
                disabled={restore.isPending}
                onClick={() => restore.mutate()}
              >
                {restore.isPending ? "Restoring…" : "Restore"}
              </button>
            )}
            {restore.isError && (
              <p className="error" style={{ margin: "2px 0 0" }}>
                {formatApiError(restore.error)}
              </p>
            )}
          </div>
        )}
        {!voided && guard.flagged && (
          <div className="warn-text" style={{ fontSize: 11.5 }}>
            {describeDuration(guard.sinceClockInSeconds)} since clock-in — longer
            than a normal day
          </div>
        )}
        {/* The revert reason stays visible on the punch until re-approval,
            so a swiped-away push never loses the explanation. */}
        {s.status === "submitted" &&
          s.edited_note?.startsWith("Approval reverted:") && (
            <div className="warn-text" style={{ fontSize: 11.5 }}>
              {s.edited_note}
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
            a bad punch is a specific punch. Edit is supervisor+ only (Q3) —
            a plain foreman can still Reject, but not open the edit sheet. */}
        {(isLead || isSup) && !voided && (
          <div className="row-gap tcx-punch-actions">
            {isLead && s.status !== "rejected" && (
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
            {isSup && (
              <button
                className="button-like"
                onClick={() => setEditing((v) => !v)}
              >
                {editing ? "Close" : "Edit"}
              </button>
            )}
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
        {editing && isSup && (
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
