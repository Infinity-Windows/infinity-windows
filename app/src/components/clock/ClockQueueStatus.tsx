// Where a clock punch stands when the server does not have it yet (Release 0,
// K0.1): "Clocked in 7:02 — saved on this phone, sending". Drawn on every
// clock surface — the landing bar, the sheet, the off-clock block — so a
// person reading any of them knows their punch is real and not yet in Forge,
// and never taps it a second time. A punch the phone gave up on is named
// too, with the reason, and the door to /stuck where it can be retried.

import { Link } from "react-router-dom";
import { useT, type TKey } from "../../lib/i18n";
import { useConnection } from "../../lib/offline/useWeakSignal";
import {
  tapTimeLabel,
  type ClockActionKind,
  type QueuedClockAction,
  type RefusedClockAction,
} from "../../lib/clockQueueView";

const QUEUED_KEY: Record<ClockActionKind, TKey> = {
  clock_in: "clock.queued.clockIn",
  break_start: "clock.queued.breakStart",
  break_stop: "clock.queued.breakStop",
  clock_out: "clock.queued.clockOut",
};

// The same words /stuck uses for the row, so the two screens agree.
const WHAT_KEY: Record<ClockActionKind, TKey> = {
  clock_in: "stuck.op.clockIn",
  break_start: "stuck.op.breakStart",
  break_stop: "stuck.op.breakStop",
  clock_out: "stuck.op.clockOut",
};

export function ClockQueueStatus({
  pending,
  refused,
}: {
  pending: QueuedClockAction | null;
  refused: readonly RefusedClockAction[];
}) {
  const t = useT();
  const { online } = useConnection();
  if (!pending && refused.length === 0) return null;
  // "sending" is only true with a network to send on; with none the honest
  // word is that it waits, and goes on its own.
  const state = t(online ? "clock.queued.stateSending" : "clock.queued.stateWaiting");
  return (
    <div className="clock-queue" role="status">
      {pending && (
        <p className="clock-queue-line" data-kind={pending.kind}>
          {t(QUEUED_KEY[pending.kind], { time: tapTimeLabel(pending.tappedAt), state })}
        </p>
      )}
      {refused.map((r) => (
        <p key={r.entryId} className="clock-queue-line refused" data-kind={r.kind}>
          {t("clock.refused.line", {
            what: t(WHAT_KEY[r.kind]),
            time: tapTimeLabel(r.tappedAt),
            reason: r.reason ?? "",
          })}{" "}
          <Link to="/stuck">{t("clock.refused.link")}</Link>
        </p>
      ))}
    </div>
  );
}
