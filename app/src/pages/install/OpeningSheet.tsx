import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BeforeAfterCapture, type BeforeAfterValue } from "../../components/BeforeAfterCapture";
import { Scanner } from "../../components/Scanner";
import {
  findWindowByCode,
  findWindowBySerial,
  getWindowByWindowId,
  searchUnits,
} from "../../lib/api";
import {
  addJobNote,
  assignWindowToOpening,
  flagOpening,
  getMyProfile,
  getOpening,
  getTypeBrainStats,
  listMyOpeningsAllJobs,
  setOpeningCondition,
  setRoughOpening,
  startOpeningWork,
  synthesizeTypeTips,
  generateHowto,
} from "../../lib/install/api";
import {
  formatAssignMeta,
  rankAssignCandidates,
} from "../../lib/install/assignRank";
import { pickNextOpening } from "../../lib/install/nextOpening";
import { computeInstallPoints } from "../../lib/points";
import { checkFit, isInstallReadyStatus, readyToInstall, smallest } from "../../lib/install/fit";
import { getOpenShift, startBreak } from "../../lib/timeclock";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import {
  submitInstallViaOutbox,
} from "../../lib/install/installOutbox";
import {
  initQueueAutoFlush,
  pendingTranscriptionCount,
  pendingUploadCount,
  retryTranscriptions,
} from "../../lib/install/queue";
import { MEMO_TOPICS, isForemanPlus, type MemoTopics } from "../../lib/install/types";
import { createIssue } from "../../lib/issues";
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

  const { effectiveRole } = useEffectiveRole();

  const [scanOpen, setScanOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  // Post-install "spam-through" modal (installers) + start-of-task gate error.
  const [doneModal, setDoneModal] = useState(false);
  const [startGateError, setStartGateError] = useState<string | null>(null);

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
  const [complicationText, setComplicationText] = useState("");

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

  // Installer's assignments across all jobs — precomputed so tapping "Next one"
  // after an install is instant (sub-5s loop goal).
  const myOpenings = useQuery({
    queryKey: ["myOpenings", myProfile.data?.id],
    queryFn: () => listMyOpeningsAllJobs(myProfile.data!.id),
    enabled: Boolean(myProfile.data?.id),
  });

  // Open shift so Lunch/Break can start a break without a round-trip.
  const openShift = useQuery({
    queryKey: ["openShift", myProfile.data?.id],
    queryFn: () => getOpenShift(myProfile.data!.id),
    enabled: Boolean(myProfile.data?.id),
  });

  const isInstaller = !isForemanPlus(effectiveRole);

  // The single next window to jump to (excludes this one; ready-first ordering).
  const nextOpening = useMemo(
    () => pickNextOpening(myOpenings.data ?? [], openingId),
    [myOpenings.data, openingId],
  );

  const goToNext = () => {
    if (nextOpening) {
      navigate(`/projects/${nextOpening.project_id}/opening/${nextOpening.id}`);
    } else {
      navigate("/my-work");
    }
  };

  // Mark in-progress once (soft lock so the lead board + other crew see it).
  // start_opening_work now hard-requires an open shift + signed toolbox; if the
  // guard fires we surface a friendly gate instead of silently failing.
  const startedLockRef = useRef(false);
  useEffect(() => {
    const o = opening.data;
    if (!o || startedLockRef.current) return;
    if (o.status !== "installed" && !o.work_started_at) {
      startedLockRef.current = true;
      void startOpeningWork(openingId).catch((e) => {
        const msg = String((e as { message?: string })?.message ?? e);
        if (/clock in|toolbox/i.test(msg)) {
          setStartGateError(
            "Clock in and sign today's toolbox talk to start this task.",
          );
        }
      });
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

  // Resolve the hand-writable short code (or serial) then assign that unit.
  const assignByCode = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    try {
      const unit = await findWindowByCode(value);
      if (!unit) throw new Error(`No window found for "${value}"`);
      assign.mutate(unit.id);
    } catch (e) {
      setMessage(String(e));
    }
  };

  // Resolve a permanent serial (from a serial-encoded QR) then assign the unit.
  const assignBySerial = async (serial: string) => {
    try {
      const unit = await findWindowBySerial(serial);
      if (!unit) throw new Error(`No window found for serial "${serial}"`);
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

  // Escalate a complication straight to the foreman as an urgent issue.
  const complication = useMutation({
    mutationFn: (note: string) =>
      createIssue({
        projectId,
        openingId,
        kind: "complication",
        urgency: "urgent",
        note: note || null,
      }),
    onSuccess: () => {
      setMessage("Complication sent to your foreman.");
      setComplicationText("");
      queryClient.invalidateQueries({ queryKey: ["projectIssues", projectId] });
      queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
    onError: (e) => setMessage(String(e)),
  });

  // Damaged unit blocks install: ensure the foreman has an issue, then let the
  // installer move on to their next opening instead of being stuck.
  const skip = useMutation({
    mutationFn: async () => {
      // A damaged unit already opened a damage issue via set_opening_condition;
      // otherwise open a complication so nothing is silently skipped.
      if (opening.data?.condition !== "damaged") {
        await createIssue({
          projectId,
          openingId,
          kind: "complication",
          urgency: "urgent",
          note: `Skipped: ${conditionNote || "blocked at opening"}`,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projectIssues", projectId] });
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      queryClient.invalidateQueries({ queryKey: ["myOpenings"] });
      // Don't strand the installer on a blocked unit — send them to the next
      // ready window (same wiring as the post-install "Next one" button).
      goToNext();
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

      // Persist the FULL install (RPC args + media + points) locally first so a
      // dead zone cannot wipe the capture. Flush then attempts the network.
      const uid = (await supabase.auth.getUser()).data.user?.id ?? null;
      const { data: userData } = await supabase.auth.getUser();
      const createdBy = userData.user?.email ?? null;
      const stamp = Date.now();

      const media: Array<{
        bucket: "install-media";
        path: string;
        contentType: string;
        kind: "photo" | "voice_memo" | "video";
        blob: Blob;
        lat?: number | null;
        lng?: number | null;
        accuracyM?: number | null;
        takenAt?: string | null;
      }> = [];
      if (photos.before) {
        media.push({
          bucket: "install-media",
          path: `${projectId}/${o.opening_code}/${stamp}-before-1.jpg`,
          contentType: photos.before.type || "image/jpeg",
          kind: "photo",
          blob: photos.before,
          lat: photos.beforeMeta?.lat ?? null,
          lng: photos.beforeMeta?.lng ?? null,
          accuracyM: photos.beforeMeta?.accuracyM ?? null,
          takenAt: photos.beforeMeta?.takenAt?.toISOString() ?? null,
        });
      }
      if (photos.after) {
        media.push({
          bucket: "install-media",
          path: `${projectId}/${o.opening_code}/${stamp}-after-1.jpg`,
          contentType: photos.after.type || "image/jpeg",
          kind: "photo",
          blob: photos.after,
          lat: photos.afterMeta?.lat ?? null,
          lng: photos.afterMeta?.lng ?? null,
          accuracyM: photos.afterMeta?.accuracyM ?? null,
          takenAt: photos.afterMeta?.takenAt?.toISOString() ?? null,
        });
      }
      if (video) {
        const vext = video.name.split(".").pop() || "mp4";
        media.push({
          bucket: "install-media",
          path: `${projectId}/${o.opening_code}/${stamp}-walkthrough.${vext}`,
          contentType: video.type || "video/mp4",
          kind: "video",
          blob: video,
        });
      }
      if (audioBlob) {
        const ext = audioBlob.type.includes("mp4") ? "m4a" : "webm";
        media.push({
          bucket: "install-media",
          path: `${projectId}/${o.opening_code}/${stamp}-memo.${ext}`,
          contentType: audioBlob.type || "audio/webm",
          kind: "voice_memo",
          blob: audioBlob,
        });
      }

      const entries = uid
        ? computeInstallPoints({
            minutes: minutes ? Number(minutes) : null,
            parMinutes: brain.data?.medianMinutes != null
              ? Math.round(brain.data.medianMinutes)
              : null,
            grade,
            hasPhotos: Boolean(photos.before || photos.after),
            hasMemo: Boolean(audioBlob),
          })
        : [];

      return submitInstallViaOutbox({
        openingId,
        projectId,
        openingCode: o.opening_code,
        assignedWindowId: o.assigned_window_id,
        createdBy,
        submitParams: {
          openingId,
          minutes: minutes ? Number(minutes) : null,
          estimateMinutes: brain.data?.medianMinutes
            ? Math.round(brain.data.medianMinutes)
            : null,
          qualityGrade: grade,
          startedAt: startedAtRef.current,
          ...topics,
        },
        points: uid
          ? {
              profileId: uid,
              entries,
              ref: openingId,
              status: "pending",
            }
          : null,
        media,
      });
    },
    onSuccess: (result) => {
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
      // Keep the open-shift/next-window data fresh for the modal actions.
      queryClient.invalidateQueries({ queryKey: ["openShift"] });
      const pending =
        result.remainingInstalls + result.remainingUploads;
      setPending(pending);
      if (result.queued || result.remainingUploads > 0) {
        setMessage(
          result.queued
            ? "Install saved on this device — will sync when you're back in signal."
            : `Install recorded. ${result.remainingUploads} file(s) queued — they'll upload when you're back in signal.`,
        );
      }
      // Installers get the fast spam-through modal (Next / Lunch / Break);
      // leads return to the job map.
      if (isInstaller) {
        setDoneModal(true);
      } else if (!result.queued && result.remainingUploads === 0) {
        navigate(`/projects/${projectId}?tab=map`);
      }
    },
    onError: (e) => setMessage(String(e)),
  });

  // Lunch/Break: start a shift break (so shift-time and task-time reconcile),
  // then head to the clock. If not clocked in, just route to the clock.
  const takeBreak = useMutation({
    mutationFn: async () => {
      const shift = openShift.data ?? (myProfile.data?.id
        ? await getOpenShift(myProfile.data.id)
        : null);
      if (shift) await startBreak(shift.id);
    },
    onSettled: () => navigate("/clock"),
  });

  const o = opening.data;
  if (opening.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!o) return <div className="page"><p className="error">Opening not found.</p></div>;

  const installed = o.status === "installed";
  const unitType = o.windows?.window_type_id ?? null;
  const typeMatches = !o.assigned_window_id || !o.window_type_id || unitType === o.window_type_id;
  const unitStatus = o.windows?.status ?? null;
  const atLocationOrLoaded = isInstallReadyStatus(unitStatus);

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
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <Link to={`/projects/${projectId}?tab=map`} className="back-chip" aria-label="Back to map">
            ‹
          </Link>
          <h1 className="opening-code-title">{o.opening_code}</h1>
        </div>
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
        <p className={/^(Window|Install|Rough|Condition|Flag|Flagged|Site|Complication)/.test(message) ? "ok" : "error"}>
          {message}
        </p>
      )}

      {/* Start-of-task gate: you can't be "on a task" unless you're clocked in
          and have signed today's toolbox talk. Friendly, non-crashing. */}
      {startGateError && !installed && (
        <div className="ready-banner ready-blocked">
          <strong>Not on the clock yet</strong>
          <p style={{ margin: "6px 0 10px" }}>{startGateError}</p>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="primary" onClick={() => navigate("/clock")}>
              Clock in
            </button>
            <button className="action-btn" onClick={() => navigate("/safety")}>
              Sign toolbox talk
            </button>
          </div>
        </div>
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
                <div className="briefing-tips watch-callout">
                  <span className="field-label" style={{ color: "var(--warn)", margin: 0 }}>Watch-outs</span>
                  <ul className="watch" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
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
              hint="Scan the window's QR — or type its short code below."
              onScan={(payload) => {
                if (payload.kind === "window") {
                  void assignByWindowId(payload.windowId);
                } else if (payload.kind === "windowCode") {
                  void assignByCode(payload.code);
                } else if (payload.kind === "windowSerial") {
                  void assignBySerial(payload.serial);
                } else {
                  setMessage("That's a slot label — scan a window label.");
                }
              }}
            />
          )}
          <label className="field-label">Type the window code</label>
          <div className="manual-entry">
            <input
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="6-char code or serial, e.g. K7M2QX"
              autoCapitalize="characters"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void assignByCode(codeInput);
                  setCodeInput("");
                }
              }}
            />
            <button
              disabled={!codeInput.trim() || assign.isPending}
              onClick={() => {
                void assignByCode(codeInput);
                setCodeInput("");
              }}
            >
              Assign
            </button>
          </div>
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
            <>
              <p className="error">
                Unit flagged damaged. Don't install — swap the unit and re-check.
                Your foreman has been notified.
              </p>
              <button
                className="action-btn"
                disabled={skip.isPending}
                onClick={() => skip.mutate()}
              >
                {skip.isPending ? "Skipping…" : "Skip for now — go to my work"}
              </button>
            </>
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

          <label className="field-label">Hit a complication?</label>
          <p className="muted">
            Something needs your foreman's attention now — this opens an urgent
            issue on the cross-job Issues board.
          </p>
          <input
            value={complicationText}
            onChange={(e) => setComplicationText(e.target.value)}
            placeholder="e.g. rotten framing, needs a decision"
          />
          <button
            className="action-btn"
            disabled={!complicationText.trim() || complication.isPending}
            onClick={() => complication.mutate(complicationText.trim())}
          >
            I have a complication — notify foreman
          </button>
        </details>
      )}

      {/* ===================== STAGE 2: INSTALL ===================== */}
      {!installed && stage === "install" && (
        <div className="install-timer">
          <div className="install-pulse" aria-hidden>
            ●
          </div>
          <p className="next-label" style={{ margin: 0 }}>Installing</p>
          <p className="next-code">{minutes || 0}<span style={{ fontSize: 28 }}> min</span></p>
          <p className="muted" style={{ margin: 0 }}>
            Timer running. Plumb, level, square — then capture it.
          </p>
          {tips.length > 0 && (
            <ol className="tip-list" style={{ textAlign: "left", width: "100%" }}>
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
          <BeforeAfterCapture value={photos} onChange={setPhotos} label={o.opening_code} />

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

      {/* ===== POST-INSTALL SPAM-THROUGH MODAL (installers) ===== */}
      {doneModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card done-modal">
            <p className="done-check" aria-hidden>✓</p>
            <h2 style={{ margin: 0 }}>Nice — window done.</h2>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              {nextOpening
                ? "Straight to the next one, or take a break."
                : "That's your last assigned window — nice work."}
            </p>
            {pending > 0 && (
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
                {pending} file(s) uploading in the background.
              </p>
            )}

            <button
              className="primary big"
              onClick={() => {
                setDoneModal(false);
                goToNext();
              }}
            >
              {nextOpening ? (
                <>
                  Next one →{" "}
                  <span style={{ opacity: 0.85 }}>{nextOpening.opening_code}</span>
                </>
              ) : (
                "All caught up — my work"
              )}
            </button>

            <div className="modal-actions">
              <button
                className="big"
                disabled={takeBreak.isPending}
                onClick={() => takeBreak.mutate()}
              >
                Lunch
              </button>
              <button
                className="big"
                disabled={takeBreak.isPending}
                onClick={() => takeBreak.mutate()}
              >
                Break
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Route wrapper: key the sheet on the opening id so tapping "Next one" (which
 * navigates within the same route) fully remounts the component — the timer,
 * stage, and all per-opening state reset for a clean sub-5s transition.
 */
export function OpeningSheetRoute() {
  const { openingId = "" } = useParams();
  return <OpeningSheet key={openingId} />;
}
