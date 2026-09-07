// A write only lands here once the outbox has given up on it (see the
// "failed" status note in outbox-core.ts: "needs human attention, never
// silently dropped"). Until this page existed, that promise was empty — a
// dead-lettered clock punch just sat in IndexedDB forever, invisible to
// everyone, which for a timecard is a payroll dispute nobody knew to have.
// This page is the human at the other end of that promise: see what got
// stuck, try it again, or decide it's not worth saving.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BackChip } from "../components/BackChip";
import { formatApiError } from "../lib/errors";
import {
  discardFailed,
  listFailed,
  retryFailed,
  subscribe,
} from "../lib/offline/outbox";
import type { OutboxOp } from "../lib/offline/outbox-core";
import {
  discardFailedInstall,
  listFailedInstalls,
  retryFailedInstall,
  subscribeSyncListeners,
} from "../lib/install/installOutbox";
import { useT, CATALOG, translate, type TFn, type TKey, type Lang } from "../lib/i18n";

const englishT: TFn = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);

/**
 * Plain words for what a write WAS, not the op code it's stored under. Typed
 * as Record<OutboxOp, TKey> on purpose: adding a new op to OutboxOp without
 * adding it here is a compile error, so this screen can never show a foreman
 * a raw code word like "checkout_packages".
 */
const OP_LABEL_KEY: Record<OutboxOp, TKey> = {
  clock_in: "stuck.op.clockIn",
  clock_out: "stuck.op.clockOut",
  break_start: "stuck.op.breakStart",
  break_stop: "stuck.op.breakStop",
  // Reachable for real since 2026-09-05: fileDailyLog queues on no signal.
  // Before that this op had no callers at all, so this label was a placeholder
  // for a row that could never appear.
  daily_log: "stuck.op.dailyLog",
  photo_upload: "stuck.op.photoUpload",
  receipt_upload: "stuck.op.receiptUpload",
  // All three pin ops read the same to a foreman — a mark got moved back —
  // the difference (one mark vs. the whole job) doesn't change what to do
  // about it here.
  pin_undo: "stuck.op.pinChange",
  pin_reset_project: "stuck.op.pinChange",
  pin_reset_opening: "stuck.op.pinChange",
  store_packages: "stuck.op.storePackages",
  checkout_packages: "stuck.op.checkoutPackages",
  take_supply: "stuck.op.takeSupply",
  bind_package: "stuck.op.bindPackage",
  stage_packages: "stuck.op.stagePackages",
  move_container: "stuck.op.moveContainer",
  set_package_area: "stuck.op.setPackageArea",
  set_package_note: "stuck.op.setPackageNote",
  receive_minted: "stuck.op.receiveMinted",
  pickup_takeoff: "stuck.op.pickupTakeoff",
  issue_photo_upload: "stuck.op.issuePhotoUpload",
  receipt_capture: "stuck.op.receiptCapture",
  receipt_answer: "stuck.op.receiptAnswer",
  // The original PDF, not the receipt itself — the receipt (page one, plus its
  // amount and job) may already have landed, so this must not read as "Receipt"
  // or a foreman would go looking for a receipt that is sitting on the table.
  receipt_document_upload: "stuck.op.receiptDocumentUpload",
  video_quiz_submit: "stuck.op.videoQuizSubmit",
};

/**
 * One row, whatever store it came from.
 *
 * There are TWO queues: the general offline outbox (clock punches, photos,
 * warehouse writes) and a separate one for finished installs, which persists
 * the RPC, the points and the media as a single durable record so a retry
 * can't half-apply. To the person holding the phone that distinction is
 * meaningless — something they did hasn't landed — so both are normalised
 * here and the list below never needs to know which store a row came from.
 */
interface StuckRow {
  id: string;
  label: string;
  when: number;
  detail: string | null;
  /** Which queue owns it, so retry/discard call the right pair. */
  source: "write" | "install";
}

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

/**
 * How long a write has been sitting here, in words rather than a timestamp.
 *
 * "Try again" replays a write exactly as it was written — the same packages,
 * the same job, the same numbers, decided whenever it was made. A stamp like
 * "8/14/2026, 4:12 PM" makes a person do that subtraction in their head while
 * standing in a warehouse, and most won't. Saying "queued 3 days ago" is the
 * one fact that changes the answer, so it goes on the row.
 *
 * This screen only ever REPORTS the age. It does not refuse an old write —
 * the check for whether a write still matches the world belongs on the
 * server, where the world actually is. Here, the person decides.
 *
 * Wording matches the rest of the app's "last seen" copy (vehicles, pin
 * history): just now / N min / N hr / N days. `t` defaults to English so the
 * plain function keeps a stable, testable identity even though the page now
 * calls it with the live language.
 */
export function queuedAgoLabel(when: number, nowMs: number, t: TFn = englishT): string {
  // Install rows carry a text timestamp that can be missing, and 0 would draw
  // a confident "1/1/1970" — worse than admitting we don't know.
  if (!Number.isFinite(when) || when <= 0) return t("stuck.queuedNoTime");
  const min = Math.floor(Math.max(0, nowMs - when) / 60_000);
  if (min < 1) return t("stuck.queuedJustNow");
  if (min < 60) return t("stuck.queuedMinAgo", { min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("stuck.queuedHrAgo", { hr });
  const days = Math.floor(hr / 24);
  return days === 1 ? t("stuck.queuedDayAgo") : t("stuck.queuedDaysAgo", { days });
}

export function StuckWrites() {
  const t = useT();
  const queryClient = useQueryClient();
  const failedQ = useQuery({ queryKey: ["failedWrites"], queryFn: listFailed });
  // A stuck INSTALL is the worst case on this screen — it is the record that a
  // window got finished — so it belongs here even though it lives in its own
  // store with its own subscribe mechanism.
  const installsQ = useQuery({
    queryKey: ["failedInstalls"],
    queryFn: listFailedInstalls,
  });

  // The outbox drains in the background (reconnect, focus, the slow interval
  // timer) — without this, a punch that finally goes through on a retry, or a
  // fresh one that just dead-lettered, wouldn't show up until the user backed
  // out of the page and back in.
  useEffect(() => {
    return subscribe(() => {
      void queryClient.invalidateQueries({ queryKey: ["failedWrites"] });
    });
  }, [queryClient]);

  // The install queue notifies separately.
  useEffect(() => {
    return subscribeSyncListeners(() => {
      void queryClient.invalidateQueries({ queryKey: ["failedInstalls"] });
    });
  }, [queryClient]);

  const refreshBoth = () => {
    void queryClient.invalidateQueries({ queryKey: ["failedWrites"] });
    void queryClient.invalidateQueries({ queryKey: ["failedInstalls"] });
  };

  const retry = useMutation({
    mutationFn: (row: StuckRow) =>
      row.source === "install" ? retryFailedInstall(row.id) : retryFailed(row.id),
    onSuccess: refreshBoth,
  });
  const discard = useMutation({
    mutationFn: (row: StuckRow) =>
      row.source === "install" ? discardFailedInstall(row.id) : discardFailed(row.id),
    onSuccess: refreshBoth,
  });

  // Throwing a write away deletes the only record that the work happened, so
  // one tap can never do it — the button has to change to a second,
  // unmistakably-different confirm before anything is deleted.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // The age is the reason this screen shows a time at all, so it can't freeze
  // at whatever it said when the page opened. A minute is fine — nothing here
  // changes faster than that.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);

  const entries: StuckRow[] = [
    ...(failedQ.data ?? []).map((e) => ({
      id: e.id,
      label: t(OP_LABEL_KEY[e.op]),
      when: e.createdAt,
      detail: e.lastError,
      source: "write" as const,
    })),
    ...(installsQ.data ?? []).map((r) => ({
      id: r.id,
      // Name the window, not the record: "Window W1 finished" is what the
      // person actually did.
      label: r.payload.openingCode
        ? t("stuck.windowFinished", { code: r.payload.openingCode })
        : t("stuck.windowFinishedNoCode"),
      when: Date.parse(r.payload.createdAt ?? "") || 0,
      detail: r.lastError,
      source: "install" as const,
    })),
  ].sort((a, b) => b.when - a.when);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{t("stuck.offlineWrites")}</p>
          <h1>{t("stuck.title")}</h1>
        </div>
        <BackChip label={t("stuck.back")} />
      </header>

      <p className="muted">{t("stuck.explain1")}</p>
      <p className="muted">{t("stuck.explain2")}</p>

      {(failedQ.isLoading || installsQ.isLoading) && <p className="muted">{t("stuck.checking")}</p>}
      {failedQ.isError && (
        <p className="error">
          {formatApiError(failedQ.error, t("stuck.checkError"))}
        </p>
      )}
      {retry.isError && (
        <p className="error">
          {formatApiError(retry.error, t("stuck.retryError"))}
        </p>
      )}
      {discard.isError && (
        <p className="error">
          {formatApiError(discard.error, t("stuck.discardError"))}
        </p>
      )}

      {!failedQ.isLoading && !failedQ.isError && entries.length === 0 && (
        <p className="muted">{t("stuck.nothingStuck")}</p>
      )}

      {entries.length > 0 && (
        <ul className="unit-list">
          {entries.map((e) => {
            const confirming = confirmingId === e.id;
            const busyRetry = retry.isPending && retry.variables?.id === e.id;
            const busyDiscard = discard.isPending && discard.variables?.id === e.id;
            return (
              <li key={e.id}>
                <div className="find-row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{e.label}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {queuedAgoLabel(e.when, now, t)}
                      {e.when > 0 ? ` · ${fmtWhen(e.when)}` : ""}
                    </div>
                    {e.detail && (
                      <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                        {e.detail}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="button-like"
                    disabled={busyRetry || busyDiscard}
                    onClick={() => {
                      // A stray confirm shouldn't survive switching to Try
                      // again on the same row.
                      if (confirming) setConfirmingId(null);
                      retry.mutate(e);
                    }}
                  >
                    {busyRetry ? t("stuck.tryingAgain") : t("stuck.tryAgain")}
                  </button>
                  <button
                    type="button"
                    className={`button-like${confirming ? " danger-outline" : ""}`}
                    disabled={busyRetry || busyDiscard}
                    onClick={() => {
                      if (confirming) {
                        setConfirmingId(null);
                        discard.mutate(e);
                      } else {
                        setConfirmingId(e.id);
                      }
                    }}
                  >
                    {busyDiscard
                      ? t("stuck.throwingAway")
                      : confirming
                        ? t("stuck.sureDeletes")
                        : t("stuck.throwAway")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
