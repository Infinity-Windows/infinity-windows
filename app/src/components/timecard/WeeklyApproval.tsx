import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { approveTimecardWeek, type TimeShift, type WeekRange } from "../../lib/timeclock";
import { formatApiError } from "../../lib/errors";
import { useT } from "../../lib/i18n";

/** One review action per person/week, shared by the roster and detail view. */
export function WeeklyApproval({ personId, range, shifts, canApprove, showRange = false }: {
  personId: string;
  range: WeekRange;
  shifts: TimeShift[];
  canApprove: boolean;
  showRange?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const rows = shifts.filter((s) => {
    const at = new Date(s.clock_in_at).getTime();
    return s.profile_id === personId && s.status !== "voided" && at >= range.start.getTime() && at < range.end.getTime();
  });
  const approved = rows.length > 0 && rows.every((s) => s.status === "approved");
  const blocked = rows.some((s) => !s.clock_out_at || !["approved", "submitted"].includes(s.status));
  const save = useMutation({
    mutationFn: () => approveTimecardWeek(personId, range, rows),
    onSuccess: () => {
      for (const key of ["teamShifts", "timecardPanel", "timecardMine", "shiftsToApprove", "payPeriodShifts"])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
  if (!rows.length) return null;
  return (
    <div className="tcx-week-review">
      {showRange && <span className="muted">{range.label}</span>}
      {approved ? (
        <span className="tcx-week-ok"><CheckCircle2 size={15} aria-hidden />{t("timecard.weekApproved")}</span>
      ) : canApprove ? (
        <>
          <button className="button-like active-pill" disabled={save.isPending || blocked} onClick={() => save.mutate()}>
            {save.isPending ? t("timecard.approving") : t("timecard.approveWeek")}
          </button>
          {blocked && <span className="muted">{t("timecard.weekNeedsCorrection")}</span>}
        </>
      ) : <span className="muted">{t("timecard.weekNeedsApproval")}</span>}
      {save.isError && <p className="error" role="alert">{formatApiError(save.error)}</p>}
    </div>
  );
}
