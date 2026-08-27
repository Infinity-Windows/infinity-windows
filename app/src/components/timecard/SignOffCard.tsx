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
          You signed {period.label} on {fmtDay(row.data.employee_signed_at)}
          {row.data.supervisor_signed_at
            ? ` · countersigned by ${row.data.supervisor?.display_name ?? "a supervisor"} ${fmtDay(row.data.supervisor_signed_at)}`
            : " · waiting on a supervisor countersign"}
          .
        </p>
      </div>
    );
  }

  return (
    <div className="detail-card" style={{ marginBottom: 12 }}>
      <h2 style={{ margin: 0, fontSize: 15 }}>Sign your timecard</h2>
      <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12.5 }}>
        {period.label} has ended. Signing says the hours in it are correct —
        it doesn't change anything, and a supervisor still countersigns it
        after you.
      </p>
      <button
        className="button-like active-pill"
        disabled={sign.isPending}
        onClick={() => sign.mutate()}
      >
        {sign.isPending ? "Signing…" : "Sign my timecard"}
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
      <span className="tcx-chip sky">Signed {fmtDay(row.data.employee_signed_at)}</span>
      {row.data.supervisor_signed_at ? (
        <span className="tcx-chip sky">
          Countersigned by {row.data.supervisor?.display_name ?? "a supervisor"}
        </span>
      ) : isSup ? (
        <button
          className="button-like active-pill"
          style={{ fontSize: 12 }}
          disabled={countersign.isPending}
          onClick={() => countersign.mutate()}
        >
          {countersign.isPending ? "Countersigning…" : "Countersign"}
        </button>
      ) : (
        <span className="muted" style={{ fontSize: 12 }}>
          Waiting on a supervisor countersign
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
