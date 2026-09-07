// Wave T8: pay-period sign-off, layered on per-punch approval (Q5). Two
// small pieces sharing one table (timecard_periods) and one read (
// getTimecardPeriod): the worker's own attestation card (My timecard) and
// the supervisor's countersign strip (TeamTimecards' drill-down, pay mode).
// "No lock plumbing beyond: a signed period shows 'signed'" — neither piece
// here disables anything; they only show status and offer the one action
// each role can take.

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import {
  countersignTimecard,
  getTimecardPeriod,
  previousPayPeriod,
  signMyTimecard,
} from "../../lib/timeclock";

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The worker's own card, shown on My timecard: the most recently ENDED pay
 * period, offered for signing once, then replaced by a plain status line.
 * Never shows anything for the still-running period — there is nothing to
 * sign yet.
 */
export function SignMyTimecardCard({ profileId }: { profileId: string | null | undefined }) {
  const t = useT();
  const qc = useQueryClient();
  const period = useMemo(() => previousPayPeriod(), []);
  const row = useQuery({
    queryKey: ["timecardPeriod", profileId, period.startIso],
    queryFn: () => getTimecardPeriod(profileId!, period.startIso),
    enabled: Boolean(profileId),
  });
  const sign = useMutation({
    mutationFn: () => signMyTimecard(period.startIso),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["timecardPeriod"] }),
  });

  if (!profileId || row.isLoading) return null;

  if (row.data?.employee_signed_at) {
    return (
      <div className="detail-card" style={{ marginBottom: 12 }}>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          {row.data.supervisor_signed_at
            ? t("timecard.signOff.signedCountersigned", {
                period: period.label,
                signedDay: fmtDay(row.data.employee_signed_at),
                supervisor: row.data.supervisor?.display_name ?? t("timecard.signOff.aSupervisor"),
                counterDay: fmtDay(row.data.supervisor_signed_at),
              })
            : t("timecard.signOff.signedWaiting", {
                period: period.label,
                signedDay: fmtDay(row.data.employee_signed_at),
              })}
        </p>
      </div>
    );
  }

  return (
    <div className="detail-card" style={{ marginBottom: 12 }}>
      <h2 style={{ margin: 0, fontSize: 15 }}>{t("timecard.signOff.title")}</h2>
      <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12.5 }}>
        {t("timecard.signOff.help", { period: period.label })}
      </p>
      <button
        className="button-like active-pill"
        disabled={sign.isPending}
        onClick={() => sign.mutate()}
      >
        {sign.isPending ? t("timecard.signOff.signing") : t("timecard.signOff.signButton")}
      </button>
      {sign.isError && <p className="error">{formatApiError(sign.error)}</p>}
    </div>
  );
}

/**
 * Supervisor-side strip on the drill-down's Pay-period tab: nothing shows
 * until the worker signs (the worker goes first, Q5), then it's a status
 * line plus one Countersign button for supervisors, or a plain wait note
 * for foremen (read-only here too — same tier as edit/void).
 */
export function PeriodSignOffStrip({
  profileId,
  periodStartIso,
  isSup,
}: {
  profileId: string;
  periodStartIso: string;
  isSup: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const row = useQuery({
    queryKey: ["timecardPeriod", profileId, periodStartIso],
    queryFn: () => getTimecardPeriod(profileId, periodStartIso),
  });
  const countersign = useMutation({
    mutationFn: () => countersignTimecard(profileId, periodStartIso),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["timecardPeriod"] }),
  });

  if (!row.data?.employee_signed_at) return null;

  return (
    <div className="row-gap tcx-signoff" style={{ alignItems: "center", flexWrap: "wrap" }}>
      <span className="tcx-chip sky">
        {t("timecard.signOff.signed", { day: fmtDay(row.data.employee_signed_at) })}
      </span>
      {row.data.supervisor_signed_at ? (
        <span className="tcx-chip sky">
          {t("timecard.signOff.countersignedBy", {
            supervisor: row.data.supervisor?.display_name ?? t("timecard.signOff.aSupervisor"),
          })}
        </span>
      ) : isSup ? (
        <button
          className="button-like active-pill"
          style={{ fontSize: 12 }}
          disabled={countersign.isPending}
          onClick={() => countersign.mutate()}
        >
          {countersign.isPending ? t("timecard.signOff.countersigning") : t("timecard.signOff.countersign")}
        </button>
      ) : (
        <span className="muted" style={{ fontSize: 12 }}>
          {t("timecard.signOff.waitingCountersign")}
        </span>
      )}
      {countersign.isError && (
        <p className="error" style={{ flexBasis: "100%", margin: "2px 0 0" }}>
          {formatApiError(countersign.error)}
        </p>
      )}
    </div>
  );
}
