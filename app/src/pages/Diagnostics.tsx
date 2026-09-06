// /diagnostics — the screen support asks for a screenshot of.
//
// Read-only. Everything a "it didn't save" conversation needs, on one page:
// which build and which database, whether the phone is online, weak or off,
// when it last heard from the database, what is waiting to send and what
// gave up, which jobs are saved on this phone and how old they are, and the
// last sixty things the connection did. "Copy report" puts the same facts on
// the clipboard as text for a message.
//
// Any signed-in role: the person holding the phone is the one who needs it.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Check, Copy, Wifi, WifiOff } from "lucide-react";
import { BackChip } from "../components/BackChip";
import { BuildIdentityCard } from "../components/BuildIdentityCard";
import { listProjects } from "../lib/api";
import { useT } from "../lib/i18n";
import { failedInstallCount, pendingInstallCount, subscribeSyncListeners } from "../lib/install/installOutbox";
import { pendingTranscriptionCount, pendingUploadCount } from "../lib/install/queue";
import { buildDiagnosticsReport } from "../lib/offline/diagnosticsReport";
import { readSavedJobs, type SavedJobRecord } from "../lib/offline/jobPack";
import { getOfflineEvents, subscribeOfflineEvents, summarizeOfflineEvents, type OfflineEvent } from "../lib/offline/telemetry";
import { useOutbox } from "../lib/offline/useOutbox";
import { agoLabel } from "../lib/offline/useSaveJobsOffline";
import { lastSuccessfulRequestAt } from "../lib/offline/weakSignal";
import { useConnection } from "../lib/offline/useWeakSignal";
import { BUILD_ID, BUILT_AT } from "../lib/pwa/buildInfo";

const NO_EVENTS: readonly OfflineEvent[] = [];

const QUEUE_LABELS: Record<string, string> = {
  clock: "Clock",
  photos: "Photos",
  receipts: "Receipts",
  logs: "Daily logs",
  warehouse: "Warehouse",
  other: "Other",
};

export function Diagnostics() {
  const t = useT();
  const { online, weak } = useConnection();
  const { counts } = useOutbox();
  const events = useSyncExternalStore(subscribeOfflineEvents, getOfflineEvents, () => NO_EVENTS);
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const [installs, setInstalls] = useState({ pending: 0, failed: 0 });
  const [uploads, setUploads] = useState({ pending: 0, transcriptions: 0 });
  const [saved, setSaved] = useState<Record<string, SavedJobRecord>>(() => readSavedJobs());
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    setNow(Date.now());
    setSaved(readSavedJobs());
    void Promise.all([pendingInstallCount(), failedInstallCount()])
      .then(([pending, failed]) => setInstalls({ pending, failed }))
      .catch(() => undefined);
    void Promise.all([pendingUploadCount(), pendingTranscriptionCount()])
      .then(([pending, transcriptions]) => setUploads({ pending, transcriptions }))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    const off = subscribeSyncListeners(refresh);
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [refresh]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const lastOk = lastSuccessfulRequestAt();
  const queues = [
    ...Object.entries(counts)
      .filter(([k, v]) => k !== "deadLetter" && typeof v === "number")
      .map(([k, v]) => ({ label: QUEUE_LABELS[k] ?? k, pending: v as number, failed: 0 })),
    { label: "Installs", pending: installs.pending, failed: installs.failed },
    { label: "Install photos", pending: uploads.pending, failed: 0 },
    { label: "Voice memos", pending: uploads.transcriptions, failed: 0 },
  ];
  if (counts.deadLetter > 0) queues.push({ label: "Gave up", pending: 0, failed: counts.deadLetter });
  const nameOf = (id: string) => projects.data?.find((p) => p.id === id)?.job_code ?? projects.data?.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const savedJobs = Object.entries(saved)
    .sort((a, b) => b[1].at - a[1].at)
    .map(([id, record]) => ({ name: nameOf(id), record }));
  const summary = summarizeOfflineEvents(events);

  async function copy() {
    const text = buildDiagnosticsReport({
      buildId: BUILD_ID,
      builtAt: BUILT_AT,
      supabaseHost: (() => {
        try {
          return new URL(import.meta.env.VITE_SUPABASE_URL as string).host;
        } catch {
          return "";
        }
      })(),
      online,
      weak,
      lastOkAt: lastOk,
      queues,
      savedJobs,
      events,
      now: Date.now(),
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard is blocked in plenty of contexts; the facts are on screen.
    }
  }

  const connectionLabel = !online ? t("diag.offline") : weak ? t("diag.weak") : t("diag.online");

  return (
    <div className="page" data-testid="diagnostics-page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{t("diag.eyebrow")}</p>
          <h1>{t("diag.title")}</h1>
        </div>
        <BackChip fallback="/settings" label={t("diag.back")} />
      </header>
      <p className="muted">{t("diag.intro")}</p>

      <div style={{ margin: "8px 0 12px" }}>
        <button type="button" className="action-btn" onClick={() => void copy()} data-testid="diag-copy">
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{" "}
          {copied ? t("diag.copied") : t("diag.copy")}
        </button>
      </div>

      <section className="detail-card" style={{ marginBottom: 12 }} data-testid="diag-connection">
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("diag.connection")}</h2>
        <p style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0" }}>
          {online ? <Wifi size={16} aria-hidden /> : <WifiOff size={16} aria-hidden />}
          <strong>{connectionLabel}</strong>
        </p>
        <p className="muted" style={{ margin: 0 }}>
          {t("diag.lastOk", { ago: lastOk ? agoLabel(t, lastOk, now) : t("diag.never") })}
        </p>
      </section>

      <section className="detail-card" style={{ marginBottom: 12 }} data-testid="diag-queues">
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("diag.queues")}</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {queues.map((q) => (
            <li key={q.label}>
              {q.label}: {q.pending}
              {q.failed > 0 ? ` · ${t("diag.needAttention", { n: q.failed })}` : ""}
            </li>
          ))}
        </ul>
      </section>

      <section className="detail-card" style={{ marginBottom: 12 }} data-testid="diag-saved">
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("diag.savedJobs")}</h2>
        {savedJobs.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("diag.none")}</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {savedJobs.map((j) => (
              <li key={j.name + j.record.at}>
                {j.name}: {agoLabel(t, j.record.at, now)}
                {j.record.failed > 0 ? ` · ${t("diag.missing", { n: j.record.failed })}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="detail-card" style={{ marginBottom: 12 }} data-testid="diag-events">
        <h2 style={{ marginTop: 0, fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}>
          <Activity size={16} aria-hidden /> {t("diag.events")}
        </h2>
        <p className="muted" style={{ margin: "0 0 8px" }}>
          {t("diag.eventsSummary", {
            timeouts: summary.timeouts,
            copies: summary.savedCopies,
            sent: summary.sent,
            jobs: summary.savedJobs,
          })}
        </p>
        {events.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("diag.noEvents")}</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                {new Date(e.at).toLocaleTimeString()} {e.type}
                {e.scope ? ` ${e.scope}` : ""}
                {e.count != null ? ` ×${e.count}` : ""}
                {e.message ? ` — ${e.message}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <BuildIdentityCard />
    </div>
  );
}
