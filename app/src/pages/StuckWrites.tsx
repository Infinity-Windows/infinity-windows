// Everything this phone still has to send, and what it sent this session.
//
// This page began as the human at the other end of the outbox's "never
// silently dropped" promise: a write that had given up sat in IndexedDB
// forever, invisible, which for a timecard is a payroll dispute nobody knew
// to have. It still does that — see what got stuck, try it again, or decide
// it is not worth saving.
//
// Since K0.6 (2026-09-23) it is also the one honest list of what is merely
// WAITING: every queue on the phone, each item with its age and its state
// (saved on this phone → sending → saved in Forge). The sync pill opens here
// whatever is queued (F5). Custom work and servicing keep their own review
// screens — a refused command is exported there before it is ever removed —
// so their rows link out rather than offering Throw away.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { BackChip } from "../components/BackChip";
import { useClock } from "../lib/clockContext";
import { formatApiError } from "../lib/errors";
import {
  discardFailed,
  listHeld,
  listMine,
  recentlySent,
  retryFailed,
  sendNow,
  subscribe,
} from "../lib/offline/outbox";
import {
  buildStuckRows,
  queuedAgoLabel as queuedAgo,
  stateLabel,
  writeLabel,
  type StuckRow,
} from "../lib/offline/stuckRows";
import {
  discardFailedInstall,
  isInstallSending,
  listInstalls,
  recentlySentInstalls,
  retryFailedInstall,
  sendInstallsNow,
  subscribeSyncListeners,
} from "../lib/install/installOutbox";
import { pendingLegacyUploadCount } from "../lib/install/legacyUploadQueue";
import { readWorkQueue, retryWork, syncWork, WORK_QUEUE_EVENT } from "../lib/customWork/queue";
import type { ServiceCommand } from "../lib/servicing/model";
import { useT } from "../lib/i18n";

/** The queues keyed by person: custom work, servicing, and what the retired
 * upload store still holds. Servicing lives outside the shell bundle and is
 * reached only from here, on demand. */
interface PersonalQueues {
  work: ReturnType<typeof readWorkQueue>;
  service: ServiceCommand[];
  serviceMedia: Array<{ id: string; filename: string; error?: string }>;
  legacy: number;
  /** A store this session could not read — said in its own plain words. */
  unreadable: string[];
}

async function readPersonalQueues(profileId: string | null): Promise<PersonalQueues> {
  const out: PersonalQueues = { work: [], service: [], serviceMedia: [], legacy: 0, unreadable: [] };
  try {
    out.legacy = await pendingLegacyUploadCount();
  } catch {
    // Cannot be opened → cannot be moving anything either; nothing to list.
  }
  if (!profileId) return out;
  try {
    out.work = readWorkQueue(profileId);
  } catch (e) {
    out.unreadable.push(formatApiError(e));
  }
  try {
    const [{ readServiceQueue }, { pendingServiceMedia }] = await Promise.all([
      import("../lib/servicing/queue"),
      import("../lib/servicing/mediaQueue"),
    ]);
    out.service = readServiceQueue(profileId);
    out.serviceMedia = (await pendingServiceMedia(profileId)).map((m) => ({
      id: m.id,
      filename: m.filename,
      error: m.error,
    }));
  } catch (e) {
    out.unreadable.push(formatApiError(e));
  }
  return out;
}

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function StuckWrites() {
  const t = useT();
  const queryClient = useQueryClient();
  const { profileId } = useClock();
  // This person's own writes: every state, with Try again / Throw away where
  // they apply. Someone else's work on this phone (2026-09-25) is read on its
  // own and shown, never offered for retry or throwing away — it is not this
  // person's to decide.
  const writesQ = useQuery({ queryKey: ["queuedWrites"], queryFn: listMine });
  const heldQ = useQuery({ queryKey: ["heldWrites"], queryFn: listHeld });
  // A stuck INSTALL is the worst case on this screen — it is the record that a
  // window got finished — so it belongs here even though it lives in its own
  // store with its own subscribe mechanism.
  const installsQ = useQuery({ queryKey: ["queuedInstalls"], queryFn: listInstalls });
  const personalQ = useQuery({
    queryKey: ["queuedPersonal", profileId],
    queryFn: () => readPersonalQueues(profileId),
  });

  // The queues drain in the background (reconnect, focus, the slow interval
  // timer) — without this, a punch that finally goes through on a retry, or a
  // fresh one that just dead-lettered, wouldn't show up until the user backed
  // out of the page and back in.
  useEffect(() => {
    return subscribe(() => {
      void queryClient.invalidateQueries({ queryKey: ["queuedWrites"] });
      void queryClient.invalidateQueries({ queryKey: ["heldWrites"] });
      // The migration out of the old store announces itself here too.
      void queryClient.invalidateQueries({ queryKey: ["queuedPersonal"] });
    });
  }, [queryClient]);

  // The install queue notifies separately.
  useEffect(() => {
    return subscribeSyncListeners(() => {
      void queryClient.invalidateQueries({ queryKey: ["queuedInstalls"] });
    });
  }, [queryClient]);

  // The per-person queues announce themselves on the window.
  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ["queuedPersonal"] });
    window.addEventListener(WORK_QUEUE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    let serviceEvent: string | null = null;
    let disposed = false;
    void import("../lib/servicing/queue")
      .then(({ SERVICE_QUEUE_EVENT }) => {
        if (disposed) return;
        serviceEvent = SERVICE_QUEUE_EVENT;
        window.addEventListener(SERVICE_QUEUE_EVENT, refresh);
      })
      .catch(() => {
        // The servicing chunk failed to load: the other triggers still refresh.
      });
    return () => {
      disposed = true;
      window.removeEventListener(WORK_QUEUE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
      if (serviceEvent) window.removeEventListener(serviceEvent, refresh);
    };
  }, [queryClient]);

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["queuedWrites"] });
    void queryClient.invalidateQueries({ queryKey: ["queuedInstalls"] });
    void queryClient.invalidateQueries({ queryKey: ["queuedPersonal"] });
  };

  const retry = useMutation({
    mutationFn: async (row: StuckRow) => {
      switch (row.source) {
        case "install":
          return retryFailedInstall(row.id);
        case "write":
          return retryFailed(row.id);
        case "work":
          if (profileId) await retryWork(profileId);
          return;
        case "service":
        case "serviceMedia": {
          if (!profileId) return;
          const [{ retryService, syncService }, { retryServiceMedia, flushServiceMedia }] =
            await Promise.all([import("../lib/servicing/queue"), import("../lib/servicing/mediaQueue")]);
          await retryService(profileId);
          await retryServiceMedia(profileId);
          await syncService(profileId);
          await flushServiceMedia(profileId);
          return;
        }
        case "legacy":
          return;
      }
    },
    onSuccess: refreshAll,
  });
  const discard = useMutation({
    mutationFn: (row: StuckRow) =>
      row.source === "install" ? discardFailedInstall(row.id) : discardFailed(row.id),
    onSuccess: refreshAll,
  });
  // "Send now": every queue gets one attempt this instant, backoff or not. A
  // person looking at bars is a better judge of the signal than the timer.
  const send = useMutation({
    mutationFn: async () => {
      await Promise.all([
        sendNow(),
        sendInstallsNow(),
        profileId ? syncWork(profileId).catch(() => false) : Promise.resolve(false),
      ]);
    },
    onSettled: refreshAll,
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

  const personal = personalQ.data;
  const sections = buildStuckRows(
    {
      writes: writesQ.data ?? [],
      installs: installsQ.data ?? [],
      isInstallSending,
      work: personal?.work ?? [],
      service: personal?.service ?? [],
      serviceMedia: personal?.serviceMedia ?? [],
      legacy: personal?.legacy ?? 0,
      sentWrites: recentlySent(),
      sentInstalls: recentlySentInstalls(),
    },
    t,
  );
  const loading = writesQ.isLoading || installsQ.isLoading || personalQ.isLoading;
  const held = heldQ.data ?? [];
  const nothingToSend =
    sections.needsYou.length === 0 && sections.waiting.length === 0 && held.length === 0;

  const renderRow = (e: StuckRow) => {
    const confirming = confirmingId === e.id;
    const busyRetry = retry.isPending && retry.variables?.id === e.id;
    const busyDiscard = discard.isPending && discard.variables?.id === e.id;
    return (
      <li key={e.id} data-state={e.state}>
        <div className="find-row">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{e.label}</div>
            <div className={`stuck-state stuck-state-${e.state}`}>{stateLabel(e.state, t)}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {e.state === "sent" && e.sentAt
                ? `${t("stuck.sentAt", { when: fmtWhen(e.sentAt) })}`
                : `${queuedAgo(e.when, now, t)}${e.when > 0 ? ` · ${fmtWhen(e.when)}` : ""}`}
            </div>
            {e.detail && (
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                {e.detail}
              </div>
            )}
          </div>
        </div>
        {(e.canRetry || e.canDiscard || e.reviewTo) && (
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            {e.canRetry && (
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
            )}
            {e.canDiscard && (
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
            )}
            {e.reviewTo && (
              <Link className="button-like" to={e.reviewTo}>
                {e.reviewTo === "/current-work" ? t("stuck.reviewCurrentWork") : t("stuck.reviewServicing")}
              </Link>
            )}
          </div>
        )}
      </li>
    );
  };

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

      {loading && <p className="muted">{t("stuck.checking")}</p>}
      {(writesQ.isError || installsQ.isError || personalQ.isError) && (
        <p className="error">
          {formatApiError(writesQ.error ?? installsQ.error ?? personalQ.error, t("stuck.checkError"))}
        </p>
      )}
      {personal?.unreadable.map((message) => (
        <p className="error" key={message}>
          {message}
        </p>
      ))}
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
      {send.isError && (
        <p className="error">
          {formatApiError(send.error, t("stuck.sendNowError"))}
        </p>
      )}

      {!loading && !writesQ.isError && nothingToSend && (
        <p className="muted">{t("stuck.nothingStuck")}</p>
      )}

      {sections.needsYou.length > 0 && (
        <section aria-labelledby="stuck-needs-you">
          <h2 id="stuck-needs-you">{t("stuck.section.needsYou")}</h2>
          <ul className="unit-list">{sections.needsYou.map(renderRow)}</ul>
        </section>
      )}

      {sections.waiting.length > 0 && (
        <section aria-labelledby="stuck-waiting">
          <div className="find-row">
            <h2 id="stuck-waiting" style={{ flex: 1 }}>{t("stuck.section.waiting")}</h2>
            <button
              type="button"
              className="button-like"
              disabled={send.isPending}
              onClick={() => send.mutate()}
            >
              {send.isPending ? t("stuck.state.sending") : t("stuck.sendNow")}
            </button>
          </div>
          <ul className="unit-list">{sections.waiting.map(renderRow)}</ul>
        </section>
      )}

      {sections.sent.length > 0 && (
        <section aria-labelledby="stuck-sent">
          <h2 id="stuck-sent">{t("stuck.section.sent")}</h2>
          <ul className="unit-list">{sections.sent.map(renderRow)}</ul>
        </section>
      )}

      {held.length > 0 && (
        <section aria-labelledby="stuck-held-title" style={{ marginTop: 20 }}>
          <h2 id="stuck-held-title" style={{ fontSize: 16 }}>{t("stuck.held.title")}</h2>
          <p className="muted">{t("stuck.held.body")}</p>
          <ul className="unit-list" data-testid="stuck-held">
            {held.map((e) => (
              <li key={e.id}>
                <div className="find-row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{writeLabel(e, t)}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {queuedAgo(e.createdAt, now, t)}
                      {e.createdAt > 0 ? ` · ${fmtWhen(e.createdAt)}` : ""}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
