// Learn → Using Forge → "Publish walkthrough videos": the supervisor/owner
// importer (lib/trainingImport.ts has the rules, docs/role-training-importer.md
// the runbook). Meant to be lazy-loaded by its host so none of it reaches a
// crew phone's entry chunk.
//
// SHOWN by the effective role (so an owner previewing "installer" does not
// see it); ALLOWED only by the server, from the real profile, on every call.
//
// Nothing here survives a reload: no queue, no stored selections, no
// background upload. A publish happens only while this page is open and only
// because somebody tapped the button — and the screen says "Published" only
// after the server confirmed it.

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { useSignedInUserId } from "../../lib/useAppTraining";
import { formatClock } from "../../lib/appTraining";
import {
  ImportError,
  canSeeImporter,
  cancelReservations,
  createFetchRpc,
  createStoredDigest,
  createXhrUploader,
  needsFreshStart,
  prepareImport,
  runImport,
  sha256Hex,
  type CancelOutcome,
  type ImportDeps,
  type ImportProblem,
  type ImportProgress,
  type ImportSession,
  type PlannedWalkthrough,
  type PublishedWalkthrough,
} from "../../lib/trainingImport";
import { useTrainingImporterT, type TrainingImporterKey, type TrainingImporterT } from "./trainingImporterCopy";
import "./trainingImporter.css";

export interface TrainingImporterProps {
  /** Told after a CONFIRMED publication. The catalog query is refreshed here
   * already; this is for a host that wants to do more (switch tabs, say). */
  onPublished?: (published: PublishedWalkthrough[]) => void;
}

type Check =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "problems"; problems: ImportProblem[] }
  | { status: "ready"; plan: PlannedWalkthrough[] };

type Run =
  | { status: "idle" }
  | { status: "running"; progress: ImportProgress }
  | { status: "failed"; code: ImportError["code"]; progress: ImportProgress | null }
  | { status: "discarded"; outcome: CancelOutcome }
  | { status: "published"; published: PublishedWalkthrough[] };

const PROBE_MS = 15_000;

// The same two values lib/supabase.ts builds its client from. The uploader
// needs them directly: it is the one request that does not go through the
// shared client (see createXhrUploader for why).
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "";
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? "";
const CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** The video's own length, read by this browser from the local file. Null if
 * it cannot (an unsupported codec — which a phone would not play either). */
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), PROBE_MS);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => finish(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => finish(null);
    video.src = url;
  });
}

async function currentSession(): Promise<{ userId: string; accessToken: string } | null> {
  const { data } = await supabase.auth.getSession();
  const s = data.session;
  return s?.user?.id && s.access_token ? { userId: s.user.id, accessToken: s.access_token } : null;
}

function newRequestId(): string {
  return crypto.randomUUID();
}

function formatMb(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function TrainingImporter({ onPublished }: TrainingImporterProps) {
  const { effectiveRole, isLoading } = useEffectiveRole();
  const { ready, userId } = useSignedInUserId();
  if (isLoading || !ready || !userId || !canSeeImporter(effectiveRole)) return null;
  // One panel per signed-in person. Another account on this computer gets a
  // brand-new panel: the previous person's manifest, file names, titles,
  // transcript text, reservations and results are gone with the old one, and
  // the old one's unmount stops its run and silences its late callbacks.
  return <ImporterPanel key={userId} actorId={userId} onPublished={onPublished} />;
}

function ImporterPanel({ actorId, onPublished }: TrainingImporterProps & { actorId: string }) {
  const t = useTrainingImporterT();
  const queryClient = useQueryClient();

  const [manifest, setManifest] = useState<File | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [check, setCheck] = useState<Check>({ status: "idle" });
  const [run, setRun] = useState<Run>({ status: "idle" });
  // One request id per checked plan; retries reuse it so the server hands
  // back the SAME versions and paths.
  const sessionRef = useRef<ImportSession | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const checkGen = useRef(0);
  const runGen = useRef(0);

  const deps = useMemo<ImportDeps>(
    () => ({
      // Token-bound on purpose, not supabase.rpc: the shared client sends
      // whoever is signed in when the request leaves (see trainingImport.ts §8).
      rpc: createFetchRpc(SUPABASE_URL, SUPABASE_ANON_KEY),
      getSession: currentSession,
      upload: createXhrUploader(SUPABASE_URL, SUPABASE_ANON_KEY),
      storedSha256: createStoredDigest(SUPABASE_URL, SUPABASE_ANON_KEY),
    }),
    [],
  );

  useEffect(
    () => () => {
      checkGen.current++;
      runGen.current++;
      abortRef.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (run.status !== "running") return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [run.status]);

  // Every change of selection is checked from scratch, and starts a new
  // request (a different plan must never reuse another plan's reservations).
  useEffect(() => {
    const gen = ++checkGen.current;
    sessionRef.current = null;
    setRun({ status: "idle" });
    if (!manifest || files.length === 0) {
      setCheck({ status: "idle" });
      return;
    }
    setCheck({ status: "checking" });
    prepareImport(manifest, files, { sha256: sha256Hex, probeDuration }).then(
      (res) => {
        if (gen !== checkGen.current) return;
        if (!res.ok) setCheck({ status: "problems", problems: res.problems });
        else {
          sessionRef.current = { requestId: newRequestId(), reservations: [] };
          setCheck({ status: "ready", plan: res.plan });
        }
      },
      () => {
        if (gen === checkGen.current) setCheck({ status: "problems", problems: [{ code: "file.unreadable" }] });
      },
    );
  }, [manifest, files]);

  const publish = useCallback(async () => {
    if (check.status !== "ready" || !sessionRef.current) return;
    const gen = ++runGen.current;
    const ctl = new AbortController();
    abortRef.current = ctl;
    // The actor is this panel's person, fixed at mount; every server call
    // re-checks that the session still belongs to them.
    setRun({ status: "running", progress: { step: "reserving", assets: {} } });
    let lastProgress: ImportProgress | null = null;
    try {
      const published = await runImport(check.plan, sessionRef.current, deps, {
        actorId,
        signal: ctl.signal,
        onProgress: (p) => {
          if (gen !== runGen.current) return;
          lastProgress = p;
          setRun({ status: "running", progress: p });
        },
        onSession: (s) => {
          if (gen === runGen.current) sessionRef.current = s;
        },
      });
      if (gen !== runGen.current) return;
      setRun({ status: "published", published });
      void queryClient.invalidateQueries({ queryKey: ["appTrainingVideos"] });
      onPublished?.(published);
    } catch (err) {
      if (gen !== runGen.current) return;
      const code = err instanceof ImportError ? err.code : "server";
      setRun({ status: "failed", code, progress: lastProgress });
    } finally {
      if (abortRef.current === ctl) abortRef.current = null;
    }
  }, [check, actorId, deps, queryClient, onPublished]);

  const stop = () => abortRef.current?.abort();

  const startOver = () => {
    sessionRef.current = { requestId: newRequestId(), reservations: [] };
    setRun({ status: "idle" });
  };

  const discard = async () => {
    const s = sessionRef.current;
    if (!s) return;
    const gen = ++runGen.current;
    try {
      const outcome = await cancelReservations(s, actorId, deps);
      if (gen !== runGen.current) return;
      sessionRef.current = { requestId: newRequestId(), reservations: [] };
      setRun({ status: "discarded", outcome });
      if (outcome.published.length) void queryClient.invalidateQueries({ queryKey: ["appTrainingVideos"] });
    } catch (err) {
      if (gen !== runGen.current) return;
      setRun({ status: "failed", code: err instanceof ImportError ? err.code : "server", progress: null });
    }
  };

  const reset = () => {
    setManifest(null);
    setFiles([]);
  };

  const running = run.status === "running";
  const hasReservations = (sessionRef.current?.reservations.length ?? 0) > 0;

  return (
    <section className="training-importer" aria-labelledby="ti-title">
      <header>
        <h2 id="ti-title">{t("ti.title")}</h2>
        <p className="muted">{t("ti.intro")}</p>
        <p className="ti-small">{t("ti.private")}</p>
      </header>

      {!CONFIGURED && <p className="ti-alert" role="alert">{t("ti.notConfigured")}</p>}

      {run.status === "published" ? (
        <Published t={t} published={run.published} onAnother={reset} />
      ) : (
        <>
          <div className="ti-pickers">
            <FilePicker
              label={t("ti.step.manifest")}
              button={t("ti.pickManifest")}
              accept="application/json,.json"
              disabled={running}
              summary={manifest ? manifest.name : t("ti.noneChosen")}
              onPick={(list) => setManifest(list[0] ?? null)}
            />
            <FilePicker
              label={t("ti.step.files")}
              button={t("ti.pickFiles")}
              accept=".mp4,.vtt,.json,.jpg,.jpeg,.png,.webp,video/mp4,text/vtt,image/jpeg,image/png,image/webp"
              multiple
              disabled={running}
              summary={files.length ? t("ti.filesChosen", { n: files.length }) : t("ti.noneChosen")}
              onPick={(list) => setFiles(list)}
            />
          </div>

          {check.status === "checking" && <p role="status" className="muted">{t("ti.checking")}</p>}
          {check.status === "problems" && <Problems t={t} problems={check.problems} />}
          {check.status === "ready" && (
            <>
              <Preview t={t} plan={check.plan} />
              {run.status === "running" ? (
                <Progress t={t} progress={run.progress} onStop={stop} />
              ) : (
                <div className="ti-actions">
                  {run.status === "failed" && (
                    <div className="ti-alert" role="alert">
                      <p className="ti-alert-title">{t("ti.failedTitle")}</p>
                      <p>{t(`ti.err.${run.code}` as TrainingImporterKey)}</p>
                      <p className="ti-small">{t("ti.keptFiles")}</p>
                    </div>
                  )}
                  {run.status === "discarded" && <Discarded t={t} outcome={run.outcome} />}
                  {run.status === "failed" && run.progress && <Progress t={t} progress={run.progress} />}
                  {run.status === "failed" && needsFreshStart(run.code) ? (
                    <button type="button" className="primary" onClick={startOver}>{t("ti.startOver")}</button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="primary ti-publish"
                        disabled={!CONFIGURED}
                        onClick={() => void publish()}
                      >
                        {run.status === "failed" ? t("ti.retry") : t("ti.publish")}
                      </button>
                      <p className="ti-small">{t("ti.publishHelp")}</p>
                    </>
                  )}
                  {run.status === "failed" && hasReservations && run.code !== "signedOut" && (
                    <button type="button" className="button-like" onClick={() => void discard()}>{t("ti.discard")}</button>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function FilePicker({
  label,
  button,
  accept,
  multiple,
  disabled,
  summary,
  onPick,
}: {
  label: string;
  button: string;
  accept: string;
  multiple?: boolean;
  disabled: boolean;
  summary: string;
  onPick: (files: File[]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    onPick(Array.from(e.target.files ?? []));
    // Allow picking the same file again after fixing it on disk.
    e.target.value = "";
  };
  return (
    <div className="ti-picker">
      <p className="ti-picker-label">{label}</p>
      <div className="ti-picker-row">
        <button type="button" className="button-like" disabled={disabled} onClick={() => ref.current?.click()}>
          {button}
        </button>
        <span className="ti-picker-summary">{summary}</span>
      </div>
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        aria-label={button}
        onChange={onChange}
      />
    </div>
  );
}

function whereLabel(t: TrainingImporterT, where: string | undefined): string {
  if (where === "installer" || where === "foreman" || where === "leadership") return t(`ti.scope.${where}`);
  return where ?? "";
}

function Problems({ t, problems }: { t: TrainingImporterT; problems: ImportProblem[] }) {
  return (
    <div className="ti-alert" role="alert">
      <p className="ti-alert-title">{t("ti.problemsTitle")}</p>
      <ul className="ti-problems">
        {problems.map((p, i) => (
          <li key={i}>
            {t(`ti.p.${p.code}` as TrainingImporterKey, { where: whereLabel(t, p.where), detail: p.detail ?? "" })}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Preview({ t, plan }: { t: TrainingImporterT; plan: PlannedWalkthrough[] }) {
  return (
    <div className="ti-preview">
      <h3>{t("ti.previewTitle")}</h3>
      <p className="ti-small">{t("ti.previewNote")}</p>
      <ul className="ti-cards">
        {plan.map((w) => (
          <li key={w.slug} className="ti-card">
            <span className="ti-badge">{t("ti.previewBadge")}</span>
            <p className="ti-scope">{t(`ti.scope.${w.slug}`)}</p>
            <h4>{w.title}</h4>
            <p className="ti-meta">
              <span>{w.version === null ? t("ti.versionNext") : t("ti.version", { n: w.version })}</span>
              <span>{t("ti.duration", { time: formatClock(w.durationSeconds) })}</span>
              <span>{t("ti.narration")}</span>
            </p>
            <p className="ti-meta">
              <span>{t("ti.chapters", { n: w.chapters.length })}</span>
              <span>{t("ti.captions", { n: w.captionCues })}</span>
              <span>{t("ti.transcript", { n: w.transcriptSegments })}</span>
            </p>
            <ul className="ti-files">
              {w.assets.map((a) => (
                <li key={a.kind}>
                  <span>{t(`ti.kind.${a.kind}`)}</span>
                  <span className="ti-file-name">{a.file.name}</span>
                  <span>{formatMb(a.bytes)}</span>
                </li>
              ))}
              {!w.assets.some((a) => a.kind === "poster") && <li className="muted">{t("ti.noPoster")}</li>}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Progress({ t, progress, onStop }: { t: TrainingImporterT; progress: ImportProgress; onStop?: () => void }) {
  const rows = Object.entries(progress.assets);
  return (
    <div className="ti-progress" aria-live="polite">
      {onStop && (
        <>
          <p className="ti-alert-title" role="status">{t(`ti.step.${progress.step}`)}</p>
          <p className="ti-small">{t("ti.keepOpen")}</p>
        </>
      )}
      {rows.length > 0 && (
        <ul className="ti-progress-list">
          {rows.map(([path, a]) => (
            <li key={path}>
              <span className="ti-progress-label">
                {t(`ti.scope.${a.slug}`)} · {t(`ti.kind.${a.kind}`)} — {t(`ti.asset.${a.state}`)}
              </span>
              <progress max={a.total || 1} value={Math.min(a.loaded, a.total || 1)} />
            </li>
          ))}
        </ul>
      )}
      {onStop && (
        <button type="button" className="button-like" onClick={onStop}>{t("ti.cancel")}</button>
      )}
    </div>
  );
}

function Published({
  t,
  published,
  onAnother,
}: {
  t: TrainingImporterT;
  published: PublishedWalkthrough[];
  onAnother: () => void;
}) {
  return (
    <div className="ti-done" role="status">
      <p className="ti-alert-title">{t("ti.doneTitle")}</p>
      <ul>
        {published.map((p) => (
          <li key={p.id}>
            {t(p.alreadyPublished ? "ti.doneAlready" : p.active ? "ti.doneLine" : "ti.doneInactive", {
              scope: t(`ti.scope.${p.slug}`),
              n: p.version,
            })}
          </li>
        ))}
      </ul>
      <button type="button" className="button-like" onClick={onAnother}>{t("ti.another")}</button>
    </div>
  );
}

function Discarded({ t, outcome }: { t: TrainingImporterT; outcome: CancelOutcome }) {
  return (
    <div role="status" className="ti-small">
      <p>{t("ti.discarded")}</p>
      {outcome.published.length > 0 && (
        <ul>
          {outcome.published.map((p) => (
            <li key={p.slug}>{t("ti.discardedPublished", { scope: t(`ti.scope.${p.slug}`), n: p.version })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
