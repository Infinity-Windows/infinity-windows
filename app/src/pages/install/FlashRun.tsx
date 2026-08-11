// Flash Run: one installer goes ahead of the crew and flashes the whole
// building, window to window, in install order — the same spam-through
// rhythm as installs. Photo → submit → the next opening's clock starts
// itself. Entry is per project; the queue is every opening that still needs
// flashing (not just the runner's assignments — flashing is whoever gets
// there first).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { listOpenings } from "../../lib/install/api";
import {
  flashingOutstanding,
  formatPhaseClock,
  listOpeningPhases,
  pauseOpeningPhase,
  phaseElapsedSeconds,
  resumeOpeningPhase,
  startOpeningPhase,
  submitOpeningPhase,
  type OpeningPhase,
} from "../../lib/install/phases";
import { PhotoCaptureSheet } from "../../components/PhotoCaptureSheet";
import type { ProjectOpening } from "../../lib/install/types";
import { isClockGateError } from "../../lib/install/installTimer";
import { formatApiError } from "../../lib/install/errors";
import { toastSuccess } from "../../lib/toast";

function phasesFor(phases: OpeningPhase[], openingId: string): OpeningPhase[] {
  return phases.filter((p) => p.opening_id === openingId);
}

export function FlashRun() {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();
  const [photo, setPhoto] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });
  const phases = useQuery({
    queryKey: ["openingPhases", projectId],
    queryFn: () => listOpeningPhases(projectId),
  });

  // The run queue: still-owed flashing, in install order. Recomputes after
  // every submit, which is what advances the run.
  const queue = useMemo(() => {
    const all = openings.data ?? [];
    const ph = phases.data ?? [];
    return all
      .filter((o) => flashingOutstanding(o, phasesFor(ph, o.id)))
      .sort(
        (a, b) =>
          (a.sequence ?? 1e9) - (b.sequence ?? 1e9) ||
          a.opening_code.localeCompare(b.opening_code, undefined, { numeric: true }),
      );
  }, [openings.data, phases.data]);

  const current: ProjectOpening | null = queue[0] ?? null;
  const runningPhase: OpeningPhase | null =
    (current &&
      (phases.data ?? []).find(
        (p) =>
          p.opening_id === current.id && p.kind === "flashing" && p.status === "active",
      )) ||
    null;
  const running = runningPhase != null;

  // The stopwatch is watched: tick every second while a clock runs.
  const ticking = Boolean(runningPhase && !runningPhase.paused_at);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["openingPhases", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
  };

  const start = useMutation({
    mutationFn: () => startOpeningPhase(current!.id, "flashing"),
    onSuccess: refresh,
    onError: (e) =>
      setMessage(
        isClockGateError(e)
          ? "Clock in and sign today's toolbox talk to start a flash run."
          : formatApiError(e),
      ),
  });

  const pauseIt = useMutation({
    mutationFn: () => pauseOpeningPhase(current!.id, "flashing"),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });
  const resumeIt = useMutation({
    mutationFn: () => resumeOpeningPhase(current!.id, "flashing"),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (!current || !photo) throw new Error("Take the finished photo first.");
      const done = await submitOpeningPhase({
        openingId: current.id,
        kind: "flashing",
        projectId,
        openingCode: current.opening_code,
        photo,
        contentType: photo.type || "image/jpeg",
      });
      // Spam-through: the next window's clock starts in the same breath, so
      // the runner's day is photo → submit → walk → photo → submit. A refused
      // start (lost signal, clocked out mid-run) leaves the submit standing.
      const next = queue.find((o) => o.id !== current.id) ?? null;
      if (next) {
        try {
          await startOpeningPhase(next.id, "flashing");
        } catch {
          /* next one starts by hand */
        }
      }
      return { done, next };
    },
    onSuccess: ({ next }) => {
      setPhoto(null);
      setMessage(null);
      toastSuccess(
        next ? `Flashed — next up ${next.opening_code}` : "Flashed — that was the last one",
      );
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const total = (openings.data ?? []).filter((o) => o.needs_flashing === true).length;
  const doneCount = total - queue.length;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Flash run</h1>
          <p className="muted" style={{ margin: 0 }}>
            {openings.isLoading
              ? "Loading…"
              : `${doneCount}/${total} flashed · ${queue.length} to go`}
          </p>
        </div>
        <Link to={`/projects/${projectId}?tab=map`} className="button-like">
          Job map
        </Link>
      </header>

      {!openings.isLoading && !current && (
        <div className="detail-card">
          <h2 style={{ marginTop: 0 }}>Nothing left to flash 🎉</h2>
          <p className="muted">
            Every opening that needs flashing on this job has a submitted photo.
          </p>
        </div>
      )}

      {current && (
        <div className="detail-card">
          <p className="next-label" style={{ margin: 0 }}>
            Next · {queue.length} to go
          </p>
          <p className="next-code" style={{ margin: "2px 0" }}>{current.opening_code}</p>
          <p className="muted" style={{ margin: 0 }}>
            {current.label?.trim() || `Sheet ${current.page_number}`}
            {current.window_types?.name ? ` · ${current.window_types.name}` : ""}
          </p>

          {!running ? (
            <button
              className="primary big"
              style={{ marginTop: 12 }}
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              {start.isPending ? "Starting…" : `Start flashing ${current.opening_code}`}
            </button>
          ) : (
            <>
              <p style={{ margin: "10px 0 0", fontVariantNumeric: "tabular-nums" }}>
                <span className="muted">Flashing clock: </span>
                <strong>
                  {runningPhase!.paused_at ? "paused · " : ""}
                  {formatPhaseClock(phaseElapsedSeconds(runningPhase!, now))}
                </strong>{" "}
                {runningPhase!.paused_at ? (
                  <button
                    className="link"
                    disabled={resumeIt.isPending}
                    onClick={() => resumeIt.mutate()}
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    className="link"
                    disabled={pauseIt.isPending}
                    onClick={() => pauseIt.mutate()}
                  >
                    Pause
                  </button>
                )}
              </p>
              <div style={{ marginTop: 8 }}>
                <PhotoCaptureSheet
                  mode="single"
                  value={photo}
                  onChange={setPhoto}
                  label={`${current.opening_code} flashing`}
                  prompt="Photo of the finished flashing"
                />
              </div>
              <button
                className="primary big"
                style={{ marginTop: 8 }}
                disabled={!photo || submit.isPending}
                onClick={() => submit.mutate()}
              >
                {submit.isPending
                  ? "Submitting…"
                  : photo
                    ? `Submit — next window starts itself`
                    : "Take the photo to submit"}
              </button>
            </>
          )}
          {message && <p className="error">{message}</p>}
        </div>
      )}

      {queue.length > 1 && (
        <div className="detail-card" style={{ marginTop: 8 }}>
          <span className="field-label">Coming up</span>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            {queue.slice(1, 9).map((o) => o.opening_code).join(" · ")}
            {queue.length > 9 ? " · …" : ""}
          </p>
        </div>
      )}
    </div>
  );
}
