import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BeforeAfterCapture, type BeforeAfterValue } from "../../components/BeforeAfterCapture";
import { Scanner } from "../../components/Scanner";
import { getWindowByWindowId, searchUnits } from "../../lib/api";
import {
  addJobNote,
  assignWindowToOpening,
  flagOpening,
  getMyProfile,
  getOpening,
  getTypeBrainStats,
  setOpeningCondition,
  setRoughOpening,
  startOpeningWork,
  submitInstallEvent,
  synthesizeTypeTips,
  generateHowto,
} from "../../lib/install/api";
import {
  formatAssignMeta,
  rankAssignCandidates,
} from "../../lib/install/assignRank";
import { awardPoints, computeInstallPoints } from "../../lib/points";
import { checkFit, readyToInstall, smallest } from "../../lib/install/fit";
import {
  enqueueUpload,
  flushQueue,
  initQueueAutoFlush,
  pendingTranscriptionCount,
  pendingUploadCount,
  retryTranscriptions,
} from "../../lib/install/queue";
import { MEMO_TOPICS, isLeadLike, type MemoTopics } from "../../lib/install/types";
import { supabase } from "../../lib/supabase";

function pickAudioMime(): string {
  const candidates = ["audio/webm", "audio/mp4", "audio/ogg"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return "";
}

const READY_LABEL: Record<string, string> = {
  ready: "READY TO INSTALL",
  blocked: "DO NOT INSTALL",
  incomplete: "CHECKS INCOMPLETE",
};

export function OpeningSheet() {
  const { projectId = "", openingId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [scanOpen, setScanOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const [recording, setRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<string>(new Date().toISOString());

  const [photos, setPhotos] = useState<BeforeAfterValue>({ before: null, after: null });
  const [video, setVideo] = useState<File | null>(null);
  const [stage, setStage] = useState<"check" | "install" | "capture">("check");
  const [minutes, setMinutes] = useState("");
  const [minutesTouched, setMinutesTouched] = useState(false);
  const [grade, setGrade] = useState<number | null>(null);
  const [topics, setTopics] = useState<Partial<MemoTopics>>({});
  const [pending, setPending] = useState(0);
  const [transcribing, setTranscribing] = useState(0);

  // Rough-opening + condition local inputs
  const [roW, setRoW] = useState<string[]>(["", "", ""]);
  const [roH, setRoH] = useState<string[]>(["", ""]);
  const [conditionNote, setConditionNote] = useState("");
  const [flagText, setFlagText] = useState("");
  const [jobNoteText, setJobNoteText] = useState("");

  const refreshStatus = () => {
    pendingUploadCount().then(setPending).catch(() => {});
    pendingTranscriptionCount().then(setTranscribing).catch(() => {});
  };

  useEffect(() => {
    initQueueAutoFlush();
    refreshStatus();
  }, []);

  const opening = useQuery({
    queryKey: ["opening", openingId],
    queryFn: () => getOpening(openingId),
  });

  const myProfile = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });

  // Mark in-progress once (soft lock so the lead board + other crew see it).
  const startedLockRef = useRef(false);
  useEffect(() => {
    const o = opening.data;
    if (!o || startedLockRef.current) return;
    if (o.status !== "installed" && !o.work_started_at) {
      startedLockRef.current = true;
      void startOpeningWork(openingId).catch(() => {});
    }
  }, [opening.data, openingId]);

  const brain = useQuery({
    queryKey: ["typeBrain", opening.data?.window_type_id],
    queryFn: () => getTypeBrainStats(opening.data!.window_type_id!),
    enabled: Boolean(opening.data?.window_type_id),
  });

  const searchResults = useQuery({
    queryKey: ["unitSearch", search],
    queryFn: () => searchUnits(search),
    enabled: search.trim().length >= 2,
  });

  const rankedSearch = useMemo(() => {
    const o = opening.data;
    return rankAssignCandidates(searchResults.data ?? [], {
      preferredTypeId: o?.window_type_id,
      projectId,
    }).slice(0, 8);
  }, [searchResults.data, opening.data, projectId]);

  // Auto-timer: minutes computed from when the sheet opened, unless overridden.
  useEffect(() => {
    if (minutesTouched) return;
    const tick = () => {
      const elapsed = Math.round(
        (Date.now() - new Date(startedAtRef.current).getTime()) / 60000,
      );
      setMinutes(String(Math.max(0, elapsed)));
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => clearInterval(id);
  }, [minutesTouched]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["opening", openingId] });
    queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    queryClient.invalidateQueries({ queryKey: ["projectUnits", projectId] });
    queryClient.invalidateQueries({ queryKey: ["projectWindows", projectId] });
  };

  const assign = useMutation({
    mutationFn: async (windowUuid: string) =>
      assignWindowToOpening(openingId, windowUuid),
    onSuccess: () => {
      setMessage("Window assigned.");
      setScanOpen(false);
      setSearch("");
      refresh();
    },
    onError: (e) => setMessage(String(e)),
  });

  const assignByWindowId = async (windowId: string) => {
    try {
      const unit = await getWindowByWindowId(windowId);
      if (!unit) throw new Error(`Unknown window ${windowId}`);
      assign.mutate(unit.id);
    } catch (e) {
      setMessage(String(e));
    }
  };

  const saveRo = useMutation({
    mutationFn: async () => {
      const w = smallest(roW.map((v) => Number(v)));
      const h = smallest(roH.map((v) => Number(v)));
      if (w == null || h == null) {
        throw new Error("Enter at least one width and one height measurement.");
      }
      return setRoughOpening(openingId, w, h);
    },
    onSuccess: () => {
      setMessage("Rough opening saved.");
      refresh();
    },
    onError: (e) => setMessage(String(e)),
  });

  const saveCondition = useMutation({
    mutationFn: (condition: "ok" | "damaged") =>
      setOpeningCondition(openingId, condition, conditionNote || null),
    onSuccess: (_data, condition) => {
      setMessage(condition === "damaged" ? "Marked damaged — office flagged." : "Condition OK.");
      refresh();
    },
    onError: (e) => setMessage(String(e)),
  });

  const flag = useMutation({
    mutationFn: (note: string | null) => flagOpening(openingId, note),
    onSuccess: (_d, note) => {
      setMessage(note ? "Flagged to your lead." : "Flag cleared.");
      setFlagText("");
      refresh();
    },
    onError: (e) => setMessage(String(e)),
  });

  const postJobNote = useMutation({
    mutationFn: (note: string) => addJobNote(projectId, note),
    onSuccess: () => {
      setMessage("Site note sent to the lead.");
      setJobNoteText("");
    },
    onError: (e) => setMessage(String(e)),
  });

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickAudioMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch (e) {
      setMessage(`Mic unavailable: ${String(e)}`);
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    setRecording(false);
  };

  const submit = useMutation({
    mutationFn: async () => {
      const o = opening.data;
      if (!o) throw new Error("Opening not loaded.");

      const event = await submitInstallEvent({
        openingId,
        minutes: minutes ? Number(minutes) : null,
        estimateMinutes: brain.data?.medianMinutes
          ? Math.round(brain.data.medianMinutes)
          : null,
        qualityGrade: grade,
        startedAt: startedAtRef.current,
        ...topics,
      });

      // Award points for this install — PENDING until QC signs off. Ref is the
      // opening id so QC can confirm/void. Par matches the displayed value.
      const uid = (await supabase.auth.getUser()).data.user?.id;
      if (uid) {
        const entries = computeInstallPoints({
          minutes: minutes ? Number(minutes) : null,
          parMinutes: brain.data?.medianMinutes != null
            ? Math.round(brain.data.medianMinutes)
            : null,
          grade,
          hasPhotos: Boolean(photos.before || photos.after),
          hasMemo: Boolean(audioBlob),
        });
        await awardPoints(uid, entries, openingId, "pending").catch(() => {});
      }

      const { data: userData } = await supabase.auth.getUser();
      const createdBy = userData.user?.email ?? null;
      const stamp = Date.now();

      // Enqueue photos BEFORE the voice memo so they exist in the DB by the
      // time transcription (audio flush) runs vision on them.
      const photoFiles: { file: File; tag: string }[] = [];
      if (photos.before) photoFiles.push({ file: photos.before, tag: "before" });
      if (photos.after) photoFiles.push({ file: photos.after, tag: "after" });
      for (const [i, p] of photoFiles.entries()) {
        await enqueueUpload(
          {
            bucket: "install-media",
            path: `${projectId}/${o.opening_code}/${stamp}-${p.tag}-${i + 1}.jpg`,
            contentType: p.file.type || "image/jpeg",
            kind: "photo",
            installEventId: event.id,
            windowId: o.assigned_window_id,
            createdBy,
          },
          p.file,
        );
      }
      if (video) {
        const vext = video.name.split(".").pop() || "mp4";
        await enqueueUpload(
          {
            bucket: "install-media",
            path: `${projectId}/${o.opening_code}/${stamp}-walkthrough.${vext}`,
            contentType: video.type || "video/mp4",
            kind: "video",
            installEventId: event.id,
            windowId: o.assigned_window_id,
            createdBy,
          },
          video,
        );
      }
      if (audioBlob) {
        const ext = audioBlob.type.includes("mp4") ? "m4a" : "webm";
        await enqueueUpload(
          {
            bucket: "install-media",
            path: `${projectId}/${o.opening_code}/${stamp}-memo.${ext}`,
            contentType: audioBlob.type || "audio/webm",
            kind: "voice_memo",
            installEventId: event.id,
            windowId: o.assigned_window_id,
            createdBy,
          },
          audioBlob,
        );
      }
      const flush = await flushQueue();
      return flush;
    },
    onSuccess: (flush) => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["projectUnits", projectId] });
      queryClient.invalidateQueries({ queryKey: ["myOpenings"] });
      // Auto-refresh the type's tips once it crosses the synthesis threshold —
      // no manual button needed. Fire-and-forget; the brain updates in the bg.
      const typeId = opening.data?.window_type_id;
      if (typeId && (brain.data?.installCount ?? 0) + 1 >= 3) {
        void synthesizeTypeTips(typeId)
          .then(() => generateHowto(typeId).catch(() => {}))
          .then(() => {
            queryClient.invalidateQueries({ queryKey: ["typeBrain", typeId] });
          })
          .catch(() => {});
      }
      // Installers loop back to their worklist (next window on top);
      // leads return to the job map.
      const dest =
        myProfile.data && !isLeadLike(myProfile.data.role)
          ? "/my-work"
          : `/projects/${projectId}?tab=map`;
      if (flush.remaining > 0) {
        setMessage(
          `Install recorded. ${flush.remaining} file(s) queued — they'll upload when you're back in signal.`,
        );
        setPending(flush.remaining);
      } else {
        navigate(dest);
      }
    },
    onError: (e) => setMessage(String(e)),
  });

  const o = opening.data;
  if (opening.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!o) return <div className="page"><p className="error">Opening not found.</p></div>;

  const installed = o.status === "installed";
  const unitType = o.windows?.window_type_id ?? null;
  const typeMatches = !o.assigned_window_id || !o.window_type_id || unitType === o.window_type_id;
  const unitStatus = o.windows?.status ?? null;
  const atLocationOrLoaded =
    unitStatus === "staged" || unitStatus === "loaded" || unitStatus === "in_warehouse";

  const fit = checkFit({
    unitWidthIn: o.window_types?.width_in,
    unitHeightIn: o.window_types?.height_in,
    roWidthIn: o.ro_width_in,
    roHeightIn: o.ro_height_in,
  });

  const ready = readyToInstall({
    hasUnit: Boolean(o.assigned_window_id),
    typeMatches,
    fit: fit.verdict,
    condition: o.condition,
    atLocationOrLoaded,
  });

  const tips = brain.data?.tips ?? [];
  const watchOuts = brain.data?.watchOuts ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <h1>{o.opening_code}</h1>
        <Link to={`/projects/${projectId}?tab=map`} className="button-like">
          Map
        </Link>
      </header>

      <div className="detail-card">
        <p>
          <strong>{o.window_types?.type_code ?? "Type not set"}</strong>{" "}
          <span className="muted">{o.window_types?.name}</span>
          {o.window_types?.width_in && o.window_types?.height_in && (
            <span className="muted">
              {" "}· {o.window_types.width_in}×{o.window_types.height_in}"
            </span>
          )}
        </p>
        {o.label && <p className="muted">{o.label}</p>}
        <p>
          Status: <span className={installed ? "ok" : "warn-text"}>{o.status}</span>
        </p>
        {pending > 0 && (
          <p className="warn-text">{pending} upload(s) waiting for signal.</p>
        )}
        {transcribing > 0 && (
          <p className="muted">
            {transcribing} memo(s) awaiting AI transcription.{" "}
            <button
              className="link"
              onClick={() => {
                void retryTranscriptions().then(() => {
                  refreshStatus();
                  queryClient.invalidateQueries({ queryKey: ["opening", openingId] });
                });
              }}
            >
              Retry now
            </button>
          </p>
        )}
      </div>

      {message && (
        <p className={/^(Window|Install|Rough|Condition|Flag|Flagged|Site)/.test(message) ? "ok" : "error"}>
          {message}
        </p>
      )}

      {/* --- Stage stepper (installer critical path) --- */}
      {!installed && (
        <nav className="hub-tabs" aria-label="Install steps">
          {(["check", "install", "capture"] as const).map((s, i) => (
            <button
              key={s}
              type="button"
              className={stage === s ? "hub-tab active" : "hub-tab"}
              onClick={() => setStage(s)}
            >
              {i + 1}. {s === "check" ? "Check" : s === "install" ? "Install" : "Capture"}
            </button>
          ))}
        </nav>
      )}

      {/* --- READY-TO-INSTALL GATE (always visible while working) --- */}
      {!installed && (
        <div className={`ready-banner ready-${ready.status}`}>
          <strong>{READY_LABEL[ready.status]}</strong>
          <ul>
            {ready.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ===================== STAGE 1: CHECK ===================== */}
      {!installed && stage === "check" && (
        <>
          {/* Pre-install briefing (north-star screen) */}
          {o.window_types && (
            <div className="briefing">
              <div className="briefing-stats">
                <span>
                  <strong>
                    {brain.data?.medianMinutes != null
                      ? `${Math.round(brain.data.medianMinutes)}m`
                      : "—"}
                  </strong>
                  target
                </span>
                <span>
                  <strong>
                    {brain.data?.p90Minutes != null
                      ? `${Math.round(brain.data.p90Minutes)}m`
                      : "—"}
                  </strong>
                  P90
                </span>
                <span>
                  <strong>
                    {(() => {
                      const d = brain.data?.outcomeDifficulty ?? o.window_types.difficulty_rating;
                      return d ? "★".repeat(d) : "—";
                    })()}
                  </strong>
                  difficulty
                </span>
                <span>
                  <strong>
                    {brain.data?.failRate != null ? `${brain.data.failRate}%` : "—"}
                  </strong>
                  fail rate
                </span>
              </div>
              {tips.length > 0 && (
                <div className="briefing-tips">
                  <span className="field-label">Top tips</span>
                  <ol>
                    {tips.slice(0, 5).map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ol>
                </div>
              )}
              {watchOuts.length > 0 && (
                <div className="briefing-tips">
                  <span className="field-label">Watch-outs</span>
                  <ul className="watch">
                    {watchOuts.slice(0, 5).map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {brain.data?.videos?.[0]?.signedUrl ? (
                <video controls src={brain.data.videos[0].signedUrl} className="golden-video" />
              ) : o.window_types.tutorial_url ? (
                <a href={o.window_types.tutorial_url} className="suggest">
                  Tutorial video →
                </a>
              ) : null}
              <Link to={`/brain/${o.window_types.id}`} className="muted brain-more">
                Full type brain →
              </Link>
            </div>
          )}

          {/* Assign inventory unit */}
          <h2>Physical window</h2>
          {o.assigned_window_id && o.windows ? (
        <p>
          <Link to={`/w/${encodeURIComponent(o.windows.window_id)}`}>
            <strong>{o.windows.window_id}</strong>
          </Link>{" "}
          {typeMatches ? (
            <span className="ok">assigned</span>
          ) : (
            <span className="error">wrong type!</span>
          )}
        </p>
      ) : installed ? (
        <p className="muted">Installed without a tracked unit.</p>
      ) : (
        <>
          <p className="muted">
            Scan the QR on the window you're putting in this opening, or search.
          </p>
          <button className="big" onClick={() => setScanOpen(!scanOpen)}>
            {scanOpen ? "Close scanner" : "Scan window QR"}
          </button>
          {scanOpen && (
            <Scanner
              hint="Scan the window's license-plate QR."
              onScan={(payload) => {
                if (payload.kind === "window") {
                  void assignByWindowId(payload.windowId);
                } else {
                  setMessage("That's a slot label — scan a window label.");
                }
              }}
            />
          )}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search W-… or type code"
          />
          {search.trim().length >= 2 && (
            <ul className="unit-list">
              {rankedSearch.map((u) => (
                <li key={u.id} className="find-row">
                  <div>
                    <strong>{u.window_id}</strong>{" "}
                    <span className="muted">{u.window_types?.type_code}</span>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {formatAssignMeta(u)}
                      {u.project_id === projectId ? " · this job" : ""}
                    </div>
                  </div>
                  <button
                    className="link"
                    style={{ marginLeft: "auto" }}
                    onClick={() => assign.mutate(u.id)}
                  >
                    Assign
                  </button>
                </li>
              ))}
              {rankedSearch.length === 0 && (
                <p className="muted">No matching units (type filter applied).</p>
              )}
            </ul>
          )}
        </>
      )}

      {/* --- FIT CHECK (rough opening) --- */}
      {!installed && (
        <>
          <h2>Rough opening</h2>
          <p className="muted">
            Measure width at 3 points, height at 2. We use the smallest.
          </p>
          <label className="field-label">Width (in) — 3 points</label>
          <div className="ro-row">
            {roW.map((v, i) => (
              <input
                key={i}
                type="number"
                inputMode="decimal"
                step="0.0625"
                value={v}
                placeholder={["top", "mid", "bot"][i]}
                onChange={(e) => {
                  const next = [...roW];
                  next[i] = e.target.value;
                  setRoW(next);
                }}
              />
            ))}
          </div>
          <label className="field-label">Height (in) — 2 points</label>
          <div className="ro-row">
            {roH.map((v, i) => (
              <input
                key={i}
                type="number"
                inputMode="decimal"
                step="0.0625"
                value={v}
                placeholder={["left", "right"][i]}
                onChange={(e) => {
                  const next = [...roH];
                  next[i] = e.target.value;
                  setRoH(next);
                }}
              />
            ))}
          </div>
          <button
            className="action-btn"
            disabled={saveRo.isPending}
            onClick={() => saveRo.mutate()}
          >
            {saveRo.isPending ? "Saving…" : "Save rough opening"}
          </button>
          <div className={`fit-verdict fit-${fit.verdict}`}>
            {o.ro_width_in != null && o.ro_height_in != null ? (
              <>
                <strong>RO {o.ro_width_in}×{o.ro_height_in}"</strong> — {fit.message}
              </>
            ) : (
              <span className="muted">{fit.message}</span>
            )}
          </div>
        </>
      )}

      {/* --- CONDITION / DAMAGE CHECK --- */}
      {!installed && o.assigned_window_id && (
        <>
          <h2>Condition on arrival</h2>
          <div className="grade-row">
            <button
              className={o.condition === "ok" ? "grade-btn selected" : "grade-btn"}
              onClick={() => saveCondition.mutate("ok")}
              disabled={saveCondition.isPending}
            >
              OK
            </button>
            <button
              className={o.condition === "damaged" ? "grade-btn selected danger" : "grade-btn"}
              onClick={() => saveCondition.mutate("damaged")}
              disabled={saveCondition.isPending}
            >
              Damaged
            </button>
          </div>
          <input
            value={conditionNote}
            onChange={(e) => setConditionNote(e.target.value)}
            placeholder="Damage note (optional)"
          />
          {o.condition === "damaged" && (
            <p className="error">
              Unit flagged damaged. Don't install — swap the unit and re-check.
            </p>
          )}
        </>
      )}

          <button
            className="primary big"
            disabled={ready.status === "blocked"}
            onClick={() => setStage("install")}
          >
            {ready.status === "blocked" ? "Resolve blockers to start" : "Start install →"}
          </button>
        </>
      )}

      {/* --- Exceptions: flag + site note (not during install screen) --- */}
      {!installed && stage !== "install" && (
        <details className="more-actions">
          <summary className="muted">Flag a problem / site note</summary>
          {o.flag_note ? (
            <div className="fit-verdict fit-too_small">
              <strong>Flagged:</strong> {o.flag_note}{" "}
              <button className="link" onClick={() => flag.mutate(null)}>
                Clear
              </button>
            </div>
          ) : (
            <>
              <p className="muted">
                Stuck or something's wrong? Send it to your lead — it shows in
                their dispatch blockers.
              </p>
              <input
                value={flagText}
                onChange={(e) => setFlagText(e.target.value)}
                placeholder="e.g. wrong unit delivered, access blocked"
              />
              <button
                className="action-btn"
                disabled={!flagText.trim() || flag.isPending}
                onClick={() => flag.mutate(flagText.trim())}
              >
                Flag to lead
              </button>
            </>
          )}

          <label className="field-label">Site note for the lead (optional)</label>
          <input
            value={jobNoteText}
            onChange={(e) => setJobNoteText(e.target.value)}
            placeholder="General note about this job/site"
          />
          <button
            className="action-btn"
            disabled={!jobNoteText.trim() || postJobNote.isPending}
            onClick={() => postJobNote.mutate(jobNoteText.trim())}
          >
            Send site note
          </button>
        </details>
      )}

      {/* ===================== STAGE 2: INSTALL ===================== */}
      {!installed && stage === "install" && (
        <div className="detail-card">
          <p className="next-label">INSTALLING</p>
          <p className="next-code">{minutes || 0} min</p>
          <p className="muted">Timer running. Plumb, level, square — then capture it.</p>
          {tips.length > 0 && (
            <ol className="tip-list">
              {tips.slice(0, 3).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ol>
          )}
          <button className="primary big" onClick={() => setStage("capture")}>
            Done — capture it →
          </button>
        </div>
      )}

      {/* ===================== STAGE 3: CAPTURE ===================== */}
      {!installed && stage === "capture" && (
        <>
          <h2>Photos</h2>
          <p className="muted">Before and after — the after lines up over the before.</p>
          <BeforeAfterCapture value={photos} onChange={setPhotos} />

          <label className="field-label">Walkthrough video (optional)</label>
          <label className="action-btn" style={{ cursor: "pointer" }}>
            {video ? `${video.name} — replace` : "Add a short video"}
            <input
              type="file"
              accept="video/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => {
                setVideo(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
          </label>

          <h2>Install memo</h2>
          <p className="muted">
            Record once and talk it through — AI fills the fields from your voice
            and photos. Edit anything after.
          </p>
          <button
            className={recording ? "big record-btn recording" : "big record-btn"}
            onClick={recording ? stopRecording : startRecording}
          >
            {recording ? "■ Stop recording" : audioBlob ? "● Re-record memo" : "● Record memo"}
          </button>
          {audioUrl && !recording && (
            <audio controls src={audioUrl} className="audio-preview" />
          )}

          <ol className="topic-prompts">
            {MEMO_TOPICS.map((t) => (
              <li key={t.key} className={recording ? "active" : ""}>
                {t.prompt}
              </li>
            ))}
          </ol>

          <details className="topic-fields">
            <summary className="muted">Type notes instead (optional)</summary>
            {MEMO_TOPICS.map((t) => (
              <div key={t.key}>
                <label className="field-label">{t.prompt}</label>
                <input
                  value={topics[t.key] ?? ""}
                  onChange={(e) =>
                    setTopics({ ...topics, [t.key]: e.target.value || null })
                  }
                />
              </div>
            ))}
          </details>

          <label className="field-label">
            Minutes {!minutesTouched && <span className="muted">(auto-timed — tap to override)</span>}
          </label>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={minutes}
            onChange={(e) => {
              setMinutes(e.target.value);
              setMinutesTouched(true);
            }}
            placeholder="e.g. 45"
          />

          <label className="field-label">Quality grade</label>
          <div className="grade-row">
            {[1, 2, 3, 4, 5].map((g) => (
              <button
                key={g}
                className={grade === g ? "grade-btn selected" : "grade-btn"}
                onClick={() => setGrade(g)}
              >
                {g}
              </button>
            ))}
          </div>

          {ready.status === "blocked" && (
            <p className="error">
              This opening is blocked ({ready.reasons.join(" ")}). Resolve before
              recording the install.
            </p>
          )}

          <button
            className="primary big"
            disabled={submit.isPending || recording || ready.status === "blocked"}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? "Saving…" : "Submit install"}
          </button>
          {!o.assigned_window_id && (
            <p className="muted">
              No unit linked yet — you can still submit; the memo attaches to
              the opening and type.
            </p>
          )}
        </>
      )}
    </div>
  );
}
