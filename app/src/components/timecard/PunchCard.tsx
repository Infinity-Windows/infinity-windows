// One punch, Horizon style: card with a left accent rail, job on top, cost
// code under it, mono time range, duration flush right, amber break line
// nested below. All of Infinity's per-punch truth stays on the card — status,
// injury, crew time-flag, reject reason, edit history, runaway warning — and
// the per-punch Approve / Reject / Edit actions live at the bottom edge.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coffee } from "lucide-react";
import { formatApiError } from "../../lib/errors";
import { useT, type TKey } from "../../lib/i18n";
import { getMyProfile } from "../../lib/install/api";
import { sendPush } from "../../lib/permissions/pushServer";
import {
  elapsedWorkSeconds,
  restoreShift,
  shiftHours,
  type TimeShift,
} from "../../lib/timeclock";
import { describeDuration, needsFinishTime, shiftGuard } from "../../lib/shiftGuard";
import { ShiftEditor, ShiftHistory, type CostOpt, type ProjectOpt } from "./ShiftEditor";
import { fmtHours, fmtTime } from "./format";

/** The raw DB status word, translated for display — never rendered as-is. */
const STATUS_KEY: Record<TimeShift["status"], TKey> = {
  open: "timecard.status.open",
  submitted: "timecard.status.submitted",
  approved: "timecard.status.approved",
  rejected: "timecard.status.rejected",
  needs_finish: "timecard.status.needsFinish",
  voided: "timecard.status.voided",
};

interface PunchCardProps {
  shift: TimeShift;
  isLead: boolean;
  isSup: boolean;
  projects: ProjectOpt[];
  costCodes: CostOpt[];
  reject: { isPending: boolean; mutate: (args: { id: string; reason: string }) => void; error?: unknown };
}

export function PunchCard({ shift: s, isLead, isSup, projects, costCodes, reject }: PunchCardProps) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  // T3: the persistent restore path for the "Show removed" list, once the
  // five-second Undo toast on the delete itself has already expired.
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const isMine = Boolean(me.data?.id) && me.data?.id === s.profile_id;
  const restore = useMutation({
    mutationFn: () => restoreShift(s.id),
    onSuccess: () => {
      // K4: a punch coming BACK moves somebody's hours exactly as much as one
      // going away did, and the delete already pushed. Tell them both halves.
      if (!isMine) {
        // Same caller-language caveat as TimecardPanel's revert push — see
        // the comment there.
        void sendPush({
          profileIds: [s.profile_id],
          title: t("timecard.push.restoredTitle"),
          body: t("timecard.push.restoredBody"),
          tag: `timecard-restored-${s.id}`,
          url: "/timecard",
        });
      }
      qc.invalidateQueries({ queryKey: ["teamShifts"] });
      qc.invalidateQueries({ queryKey: ["timecardMine"] });
      qc.invalidateQueries({ queryKey: ["timecardPanel"] });
      qc.invalidateQueries({ queryKey: ["unfinishedShifts"] });
    },
  });

  const voided = s.status === "voided";
  const removedReason = s.voided_reason ?? s.edited_note;
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
            {s.projects?.job_code ?? t("timecard.noJob")}
            {voided && <span className="tcx-chip bad">{t("timecard.deleted")}</span>}
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
          {fmtTime(s.clock_in_at)} – {open ? t("timecard.active") : fmtTime(s.clock_out_at)}
        </div>
        {s.break_seconds > 0 && (
          <div className="tcx-break">
            <Coffee size={12} aria-hidden />
            {t("timecard.onBreaksExcluded", { h: fmtHours(s.break_seconds / 3600) })}
          </div>
        )}
        {/* T4: the server closed this one on its own, not the person. */}
        {!voided && s.closed_reason && (
          <div className="muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>
            {s.closed_reason === "auto-closed by next clock-in"
              ? t("timecard.autoClosed")
              : s.closed_reason}
          </div>
        )}

        <div className="tcx-punch-status" style={{ fontSize: 11.5 }}>
          <span className={`tcx-status ${s.status}`}>
            {needsFinishTime(s) ? t("timecard.needsFinishTime") : t(STATUS_KEY[s.status])}
          </span>
          {s.injured && <span className="tcx-chip bad">{t("timecard.injury")}</span>}
          {s.injured && s.injury_note && (
            <span className="muted" style={{ fontSize: 12 }}>
              &ldquo;{s.injury_note}&rdquo;
            </span>
          )}
          {/* The crew member answered "No" to "is your time correct?" at
              clock-out — the day is theirs to dispute; the office sees it here. */}
          {s.time_confirmed === false && (
            <span className="tcx-chip bad">{t("timecard.timeFlagged")}</span>
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
                {t("timecard.editedByHistory", { name: s.editor?.display_name ?? t("timecard.someone") })}
              </button>
            ) : (
              // .tcx-chip is muted-colored by default (index.css) — exactly
              // the "edited by <name>" muted line T2 asked for.
              <span className="tcx-chip">
                {t("timecard.editedBy", { name: s.editor?.display_name ?? t("timecard.someone") })}
              </span>
            ))}
        </div>
        {historyOpen && isSup && <ShiftHistory shiftId={s.id} />}
        {voided && (
          <div className="muted" style={{ fontSize: 11.5 }}>
            <span style={{ fontStyle: "italic" }}>
              {s.voider?.display_name
                ? t("timecard.removedBy", { name: s.voider.display_name })
                : t("timecard.removed")}
              {removedReason && t("timecard.removedReason", { reason: removedReason })}
            </span>
            {isSup && (
              <button
                className="button-like"
                style={{ marginLeft: 8, fontSize: 11, padding: "1px 8px" }}
                disabled={restore.isPending}
                onClick={() => restore.mutate()}
              >
                {restore.isPending ? t("timecard.restoring") : t("timecard.restore")}
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
            {t("timecard.sinceClockInLong", { duration: describeDuration(guard.sinceClockInSeconds) })}
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
            {t("timecard.noteLabel", { note: s.note })}
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
                {t("timecard.reject")}
              </button>
            )}
            {isSup && (
              <button
                className="button-like"
                onClick={() => setEditing((v) => !v)}
              >
                {editing ? t("timecard.close") : t("timecard.edit")}
              </button>
            )}
          </div>
        )}
        {rejecting && (
          <div className="row-gap" style={{ marginTop: 6 }}>
            <input
              type="text"
              style={{ flex: 1 }}
              placeholder={t("timecard.reasonOptional")}
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
              {t("timecard.sendBack")}
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
