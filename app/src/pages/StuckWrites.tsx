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

/**
 * Plain words for what a write WAS, not the op code it's stored under. Typed
 * as Record<OutboxOp, string> on purpose: adding a new op to OutboxOp without
 * adding it here is a compile error, so this screen can never show a foreman
 * a raw code word like "checkout_packages".
 */
const OP_LABELS: Record<OutboxOp, string> = {
  clock_in: "Clock in",
  clock_out: "Clock out",
  break_start: "Break started",
  break_stop: "Break ended",
  daily_log: "Daily log",
  photo_upload: "Photo",
  receipt_upload: "Receipt",
  // All three pin ops read the same to a foreman — a mark got moved back —
  // the difference (one mark vs. the whole job) doesn't change what to do
  // about it here.
  pin_undo: "Plan pin change",
  pin_reset_project: "Plan pin change",
  pin_reset_opening: "Plan pin change",
  store_packages: "Packages checked in",
  checkout_packages: "Packages checked out",
  take_supply: "Supplies taken",
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

export function StuckWrites() {
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

  const entries: StuckRow[] = [
    ...(failedQ.data ?? []).map((e) => ({
      id: e.id,
      label: OP_LABELS[e.op],
      when: e.createdAt,
      detail: e.lastError,
      source: "write" as const,
    })),
    ...(installsQ.data ?? []).map((r) => ({
      id: r.id,
      // Name the window, not the record: "Window W1 finished" is what the
      // person actually did.
      label: r.payload.openingCode
        ? `Window ${r.payload.openingCode} finished`
        : "Window finished",
      when: Date.parse(r.payload.createdAt ?? "") || 0,
      detail: r.lastError,
      source: "install" as const,
    })),
  ].sort((a, b) => b.when - a.when);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Offline writes</p>
          <h1>Stuck writes</h1>
        </div>
        <BackChip label="Back" />
      </header>

      <p className="muted">
        These are saves that never made it to the server — a clock punch, a
        photo, a plan change. Nothing here was thrown away on its own; each
        one is waiting for you to try it again or throw it away yourself.
      </p>

      {(failedQ.isLoading || installsQ.isLoading) && <p className="muted">Checking for stuck writes…</p>}
      {failedQ.isError && (
        <p className="error">
          {formatApiError(failedQ.error, "Couldn't check for stuck writes. Try again shortly.")}
        </p>
      )}
      {retry.isError && (
        <p className="error">
          {formatApiError(retry.error, "Couldn't try that write again. Try again shortly.")}
        </p>
      )}
      {discard.isError && (
        <p className="error">
          {formatApiError(discard.error, "Couldn't throw that away. Try again shortly.")}
        </p>
      )}

      {!failedQ.isLoading && !failedQ.isError && entries.length === 0 && (
        <p className="muted">
          Nothing stuck. Every save has made it to the server.
        </p>
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
                      {fmtWhen(e.when)}
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
                    {busyRetry ? "Trying again…" : "Try again"}
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
                      ? "Throwing away…"
                      : confirming
                        ? "Sure? this deletes it"
                        : "Throw away"}
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
