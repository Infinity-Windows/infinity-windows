import { BackChip } from "../../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { PhotoCaptureSheet, type BeforeAfterValue } from "../../components/PhotoCaptureSheet";
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
  listMarkSpecs,
  listMyOpeningsAllJobs,
  listUndoneInstalls,
  setOpeningCondition,
  setRoughOpening,
  undoInstall,
  synthesizeTypeTips,
  generateHowto,
  listProfiles,
} from "../../lib/install/api";
import {
  formatAssignMeta,
  rankAssignCandidates,
} from "../../lib/install/assignRank";
import { pickNextOpening } from "../../lib/install/nextOpening";
import { submitBlockersLine } from "../../lib/install/submitGate";
import {
  flashingOutstanding,
  formatPhaseClock,
  listOpeningPhases,
  phaseElapsedSeconds,
  setOpeningNeedsFlashing,
} from "../../lib/install/phases";
import { computeInstallPoints } from "../../lib/points";
import {
  BLOCK_REASONS,
  pressRedo,
  blockUnit,
  chainGraceRemainingMs,
  reattributeSession,
  startUnitSession,
} from "../../lib/install/sessions";
import { SummonPanel } from "../../components/install/SummonPanel";
import { checkFit, isInstallReadyStatus, readyToInstall, smallest } from "../../lib/install/fit";
import {
  framingIssueNote,
  roFailures,
  roVerdicts,
  type RoCheckId,
  type RoJudgment,
} from "../../lib/install/roCheck";
import {
  canStartInstall,
  clockEligibility,
  installTimer,
  isClockGateError,
  recordedMinutes,
  resolveStartedAt,
} from "../../lib/install/installTimer";
import {
  forgetLocalStart,
  recallLocalStart,
  rememberLocalStart,
} from "../../lib/install/installStart";
import { getOpenShift, isOnTheClock, startBreak } from "../../lib/timeclock";
import { myTodayCompletion } from "../../lib/toolbox";
import { useClock } from "../../lib/clockContext";
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
import { claimUnsavedWork } from "../../lib/pwa/unsavedWork";
import { indexSpecsByMark, specForOpeningCode } from "../../lib/install/specs";
import { SpecCard } from "../../components/install/SpecCard";
import { MissingSpecNotice } from "../../components/install/MissingSpecNotice";
import { OpeningMoved } from "../../components/install/OpeningMoved";
import { rememberOpening } from "../../lib/install/staleOpening";
import { useRealtimeOpenings } from "../../lib/useRealtimeOpenings";
import { createIssue, listProjectIssues, resolveIssue } from "../../lib/issues";
import type { QrPayload } from "../../lib/qr";
import { resolveWindowFromScan } from "../../lib/scanResolve";
import { supabase } from "../../lib/supabase";
import { formatApiError } from "../../lib/install/errors";
import { pushToast } from "../../lib/toast";
import { sendPush } from "../../lib/permissions/pushServer";

const windowLookups = { getWindowByWindowId, findWindowByCode, findWindowBySerial };

function pickAudioMime(): string {
  const candidates = ["audio/webm", "audio/mp4", "audio/ogg"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return "";
}

/**
 * The teach-by-picture for each rough-opening check: the opening as a frame,
 * with the measurement drawn the way you'd make it - X across the diagonals
 * for square, top/bottom lines for width, left/right lines for height.
 */
function RoDiagram({ kind }: { kind: RoCheckId }) {
  const frame = (
    <rect x="7" y="5" width="34" height="52" rx="2" fill="none"
      stroke="currentColor" strokeOpacity="0.45" strokeWidth="2" />
  );
  return (
    <svg
      className="ro-diagram"
      viewBox="0 0 48 62"
      width="44"
      height="57"
      aria-hidden
    >
      {frame}
      {kind === "square" && (
        <g stroke="#ff9a6a" strokeWidth="2.5" strokeLinecap="round">
          <line x1="9" y1="7" x2="39" y2="55" />
          <line x1="39" y1="7" x2="9" y2="55" />
        </g>
      )}
      {kind === "width" && (
        <g stroke="#ff9a6a" strokeWidth="2.5" strokeLinecap="round">
          <line x1="9" y1="12" x2="39" y2="12" />
          <line x1="9" y1="50" x2="39" y2="50" />
        </g>
      )}
      {kind === "height" && (
        <g stroke="#ff9a6a" strokeWidth="2.5" strokeLinecap="round">
          <line x1="13" y1="7" x2="13" y2="55" />
          <line x1="35" y1="7" x2="35" y2="55" />
        </g>
      )}
    </svg>
  );
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
  const location = useLocation();
  // Set when we recovered a dead opening link and sent them here instead.
  const movedFrom = (location.state as { movedFrom?: string } | null)
    ?.movedFrom;

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

  // When work began, as this device knows it. The server's stamp is the
  // authority; this only carries a start made with no signal. Seeded from
  // device memory so a reload mid-install does not lose the elapsed time.
  const [localStartedAt, setLocalStartedAt] = useState<string | null>(() =>
    recallLocalStart(openingId),
  );
  const [now, setNow] = useState(() => Date.now());

  const [photos, setPhotos] = useState<BeforeAfterValue>({ before: null, after: null });
  const [video, setVideo] = useState<File | null>(null);
  const [stage, setStage] = useState<"check" | "install" | "capture">("check");
  // The hand-typed minutes era ended with sessions (spec .scratch/sessions);
  // these stay only to feed recordedMinutes' points estimate untouched-mode.
  const [minutes] = useState("");
  const [minutesTouched] = useState(false);
  const [grade, setGrade] = useState<number | null>(null);
  const [topics, setTopics] = useState<Partial<MemoTopics>>({});
  const [pending, setPending] = useState(0);
  const [transcribing, setTranscribing] = useState(0);

  // Rough-opening + condition local inputs
  const [roW, setRoW] = useState<string[]>(["", "", ""]);
  const [roH, setRoH] = useState<string[]>(["", ""]);
  const [roDiag, setRoDiag] = useState<string[]>(["", ""]);
  const [roJudge, setRoJudge] = useState<Record<RoCheckId, RoJudgment>>({
    square: null,
    width: null,
    height: null,
  });
  const [conditionNote, setConditionNote] = useState("");
  const [flagText, setFlagText] = useState("");
  const [jobNoteText, setJobNoteText] = useState("");
  const [complicationText, setComplicationText] = useState("");

  // Everything captured on this screen lives in the state above and NOWHERE
  // else until submit hands it to the outbox, which is the point it becomes
  // durable in IndexedDB. Photos and the voice memo are the worst case: they
  // exist only as in-memory blobs, so a reload before submit loses them for
  // good. Claiming here stops the PWA update flow from auto-reloading over an
  // installer mid-opening; they get the "new version" banner instead and choose
  // their own moment. See lib/pwa/updateCore.ts.
  const hasCapture =
    audioBlob !== null ||
    photos.before !== null ||
    photos.after !== null ||
    video !== null ||
    grade !== null ||
    minutesTouched ||
    conditionNote.trim() !== "" ||
    flagText.trim() !== "" ||
    jobNoteText.trim() !== "" ||
    complicationText.trim() !== "" ||
    roW.some((v) => v.trim() !== "") ||
    roH.some((v) => v.trim() !== "");

  useEffect(() => {
    if (!hasCapture) return;
    return claimUnsavedWork();
  }, [hasCapture]);

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

  // Stream this job's openings so a phone left open on a window notices when
  // the office reloads the plans, instead of holding a dead id until someone
  // thinks to reload the page.
  useRealtimeOpenings(projectId);

  // Restore the saved checklist so a revisit shows exactly what was judged -
  // and a fixer can flip Bad back to Good. Seeded once per opening; typing in
  // progress is never clobbered by a background refetch.
  const roSeededRef = useRef<string | null>(null);
  useEffect(() => {
    const loaded = opening.data;
    if (!loaded || roSeededRef.current === loaded.id) return;
    roSeededRef.current = loaded.id;
    const saved = loaded.ro_check;
    if (!saved) return;
    const strs = (a: (string | number | null)[] | undefined, n: number) =>
      Array.from({ length: n }, (_, i) => {
        const v = a?.[i];
        return v == null || v === "" ? "" : String(v);
      });
    setRoDiag(strs(saved.diagonals, 2));
    setRoW(strs(saved.widths, 3));
    setRoH(strs(saved.heights, 2));
    setRoJudge({
      square: saved.judgments?.square ?? null,
      width: saved.judgments?.width ?? null,
      height: saved.judgments?.height ?? null,
    });
  }, [opening.data]);

  // The code is what survives a re-extract; the id does not. Remembering it
  // per-device is what lets a dead link find the same window on the new plans.
  useEffect(() => {
    const loaded = opening.data;
    if (loaded) rememberOpening(loaded.id, loaded.project_id, loaded.opening_code);
  }, [opening.data]);

  const myProfile = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });

  // Installer's assignments across all jobs — precomputed so tapping "Next one"
  // after an install is instant (sub-5s loop goal).
  const myOpenings = useQuery({
    queryKey: ["myOpenings", myProfile.data?.id],
    queryFn: () => listMyOpeningsAllJobs(myProfile.data!.id),
    enabled: Boolean(myProfile.data?.id),
  });

  // The app-wide clock, the very same shift the nav bar's timer counts — so
  // "on the clock" means one thing everywhere, and Lunch/Break can start a
  // break without a round-trip.
  const clock = useClock();

  const toolboxToday = useQuery({
    queryKey: ["toolboxToday", myProfile.data?.id],
    queryFn: () => myTodayCompletion(myProfile.data!.id),
    enabled: Boolean(myProfile.data?.id),
  });

  // The gate the banner shows AND the gate the timer obeys, read from the same
  // place so the screen can never say "you can't start this" over a running
  // clock. These are the same two conditions start_opening_work enforces
  // server-side, asked up front instead of discovered by a failed call.
  const eligibility = clockEligibility({
    clockedIn: isOnTheClock(clock.shift),
    toolboxSigned: Boolean(toolboxToday.data),
    resolved: Boolean(clock.profileId) && !clock.loading && toolboxToday.isSuccess,
  });

  const isInstaller = !isForemanPlus(effectiveRole);

  // The single next window to jump to (excludes this one; ready-first ordering).
  const nextOpening = useMemo(
    () => pickNextOpening(myOpenings.data ?? [], openingId),
    [myOpenings.data, openingId],
  );

  const goToNext = (chainedAt?: string | null) => {
    if (nextOpening) {
      // The CHAIN (spec .scratch/sessions): finish_unit already started the
      // next unit's session server-side in the same transaction — the sheet
      // arrives with the clock running and shows the 5-minute "change?"
      // banner instead of asking for a tap. When the chain didn't run (the
      // outbox held the finish offline, or the next unit refused its gate),
      // the sheet's normal Start button is simply there as always.
      navigate(`/projects/${nextOpening.project_id}/opening/${nextOpening.id}`, {
        state: chainedAt ? { chainedAt } : { carryStart: true },
      });
    } else {
      navigate("/");
    }
  };

  // When work genuinely began. Server first: `work_started_at` is only ever
  // stamped for someone with an open shift and a signed toolbox talk, so its
  // presence is itself proof this time was earned on the clock — and it
  // outlives a refresh, a new phone, and this component.
  const startedAt = resolveStartedAt(opening.data?.work_started_at, localStartedAt);
  const timer = installTimer({ eligibility: eligibility.status, startedAt, now });

  // The figure that is actually recorded, scored against par time and paid on.
  // Null when we timed nothing and nobody typed anything — an install with no
  // duration must not be filed as an install that took zero minutes.
  const submittedMinutes = recordedMinutes({
    touched: minutesTouched,
    manual: minutes,
    timer,
  });

  // No partial submits: an install is filed with its proof (after photo +
  // quality grade) or it is not filed. See lib/install/submitGate.ts.
  const submitBlockedBy = submitBlockersLine({
    grade,
    hasAfterPhoto: photos.after !== null,
  });

  // Phases: work on this opening that isn't the install (flashing today).
  // One project-level query so the map and every sheet share a cache entry.
  const phases = useQuery({
    queryKey: ["openingPhases", projectId],
    queryFn: () => listOpeningPhases(projectId),
  });
  const myPhases = (phases.data ?? []).filter((p) => p.opening_id === openingId);
  const flashing = myPhases.find((p) => p.kind === "flashing") ?? null;
  const flashingBlocked = opening.data
    ? flashingOutstanding(opening.data, myPhases)
    : false;
  // Undo an install from the window itself (foreman+): required reason,
  // nothing lost - the event is voided, never deleted.
  const [undoReason, setUndoReason] = useState("");
  const [undoOpen, setUndoOpen] = useState(false);
  // Always loaded: the history matters MOST after an undo, when the status
  // is no longer "installed". Cheap filtered query; empty for most windows.
  const undoHistory = useQuery({
    queryKey: ["undoneInstalls", openingId],
    queryFn: () => listUndoneInstalls(openingId),
  });
  const undo = useMutation({
    mutationFn: () => undoInstall(openingId, undoReason.trim()),
    onSuccess: () => {
      setUndoOpen(false);
      setUndoReason("");
      setMessage("Install undone - every record kept. The window is back on the list.");
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["undoneInstalls", openingId] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  // Redo (spec .scratch/sessions): press → foreman push → back in play.
  const [redoSheetOpen, setRedoSheetOpen] = useState(false);
  const [redoReason, setRedoReason] = useState("");
  const doRedo = useMutation({
    mutationFn: () => pressRedo(openingId, redoReason.trim()),
    onSuccess: async () => {
      setRedoSheetOpen(false);
      setRedoReason("");
      setMessage("Redo filed — the window is back on the list.");
      refresh();
      // Foreman notified, never asked (owner rule). Best-effort.
      try {
        const foremen = (await listProfiles()).filter(
          (p) => p.active && isForemanPlus(p.role),
        );
        if (foremen.length > 0 && opening.data) {
          await sendPush({
            profileIds: foremen.map((f) => f.id),
            title: `🔁 Redo — ${opening.data.opening_code}`,
            body: `${myProfile.data?.display_name ?? "An installer"}: ${redoReason.trim()}`,
            tag: `redo-${openingId}`,
            url: `/projects/${projectId}/opening/${openingId}`,
          });
        }
      } catch {
        /* push is best-effort */
      }
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const toggleNeedsFlashing = useMutation({
    mutationFn: (needs: boolean) => setOpeningNeedsFlashing(openingId, needs),
    onSuccess: () => refresh(),
    onError: (e) => setMessage(formatApiError(e)),
  });

  // Re-read the clock only while something is actually being timed. The
  // flashing stopwatch is WATCHED (people check it mid-task), so it ticks
  // every second; the install figure only needs minutes.
  const flashingRunning = flashing?.status === "active" && !flashing.paused_at;
  useEffect(() => {
    if (!startedAt && !flashingRunning) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), flashingRunning ? 1000 : 15000);
    return () => clearInterval(id);
  }, [startedAt, flashingRunning]);

  const brain = useQuery({
    queryKey: ["typeBrain", opening.data?.window_type_id],
    queryFn: () => getTypeBrainStats(opening.data!.window_type_id!),
    enabled: Boolean(opening.data?.window_type_id),
  });

  // Rich per-mark spec (shared across this mark's openings). Best-effort read.
  const markSpecs = useQuery({
    queryKey: ["markSpecs", projectId],
    queryFn: () => listMarkSpecs(projectId),
    enabled: Boolean(projectId),
  });
  const openingSpec = useMemo(
    () =>
      specForOpeningCode(
        indexSpecsByMark(markSpecs.data ?? []),
        opening.data?.opening_code,
      ),
    [markSpecs.data, opening.data?.opening_code],
  );

  // The checklist's referee: numbers judged live against the unit's size
  // (catalog type first, spec sheet as fallback - same sizes the crew reads).
  const roChecklist = useMemo(() => {
    const num = (v: string) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    return roVerdicts({
      diagonals: roDiag.map(num),
      widths: roW.map(num),
      heights: roH.map(num),
      unitWidthIn:
        opening.data?.window_types?.width_in ?? openingSpec?.width_in ?? null,
      unitHeightIn:
        opening.data?.window_types?.height_in ?? openingSpec?.height_in ?? null,
    });
  }, [roDiag, roW, roH, opening.data?.window_types, openingSpec]);

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

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["opening", openingId] });
    queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    queryClient.invalidateQueries({ queryKey: ["projectUnits", projectId] });
    queryClient.invalidateQueries({ queryKey: ["projectWindows", projectId] });
  };

  // Starting is a deliberate act — a tap that says "I am installing this now" —
  // and never a side effect of the sheet opening. Reading a door's specs cost
  // installers recorded minutes until this was a button.
  const beginInstall = useMutation({
    mutationFn: async () => {
      const startedNow = new Date().toISOString();
      try {
        await startUnitSession(openingId);
      } catch (e) {
        // A refusal from the gate is a real answer and stops us. No signal is
        // not: they are clocked in as far as this device knows, so let them
        // work and time it here until the outbox catches up.
        if (isClockGateError(e) || !canStartInstall(eligibility.status)) throw e;
      }
      rememberLocalStart(openingId, startedNow);
      return startedNow;
    },
    onSuccess: (startedNow) => {
      setLocalStartedAt(startedNow);
      setStartGateError(null);
      setStage("install");
      refresh();
    },
    onError: (e) => {
      // Only a real refusal from the gate earns the "not on the clock" banner.
      // A dead zone is a different problem and must not be dressed up as one.
      if (isClockGateError(e)) {
        setStartGateError("Clock in and sign today's toolbox talk to start this task.");
      } else {
        setMessage(formatApiError(e));
      }
    },
  });

  // A start carried in from the previous window's "Next one" tap - that tap
  // was the deliberate act, so this sheet begins the clock itself instead of
  // asking for a second tap that, skipped, files the install untimed. It runs
  // through beginInstall: same clock-in gate, same offline manners, same
  // error banner as the Start button. Consumed exactly once, and the history
  // state is cleared as it is consumed, so a reload or a back-swipe never
  // restarts a clock by accident.
  const carriedStart = useRef(false);
  const beginCarried = beginInstall.mutate;
  useEffect(() => {
    const carried = (location.state as { carryStart?: boolean } | null)?.carryStart;
    if (!carried || carriedStart.current) return;
    if (!opening.data || opening.data.status === "installed") return;
    if (startedAt) return; // already running or resumed - nothing to start
    carriedStart.current = true;
    navigate(location.pathname, { replace: true, state: {} });
    beginCarried();
  }, [location.state, location.pathname, opening.data, startedAt, navigate, beginCarried]);

  // The CHAIN banner: finish_unit started this unit's session server-side;
  // for 5 minutes the hand-off stays redirectable (spec .scratch/sessions).
  const [chainedAt, setChainedAt] = useState<string | null>(null);
  const [chainPickerOpen, setChainPickerOpen] = useState(false);
  useEffect(() => {
    const st = (location.state as { chainedAt?: string } | null)?.chainedAt;
    if (!st) return;
    navigate(location.pathname, { replace: true, state: {} });
    setChainedAt(st);
    // The chained session stamped work_started_at — pull it in.
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, location.pathname, navigate]);
  const chainGraceLeft = chainedAt ? chainGraceRemainingMs(chainedAt, now) : 0;
  const redirectChain = useMutation({
    mutationFn: (targetId: string) => reattributeSession(targetId),
    onSuccess: (_s, targetId) => {
      const target = (myOpenings.data ?? []).find((o) => o.id === targetId);
      setChainPickerOpen(false);
      setChainedAt(null);
      if (target) {
        navigate(`/projects/${target.project_id}/opening/${target.id}`, {
          state: { chainedAt: new Date().toISOString() },
        });
      }
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  // BLOCK: the first-class exit (spec .scratch/sessions) — reason sheet,
  // issue link/auto-create server-side, then the same hand-off as finish.
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockOther, setBlockOther] = useState("");
  const doBlock = useMutation({
    mutationFn: (reason: string) =>
      blockUnit({
        openingId,
        reason,
        nextOpeningId: nextOpening?.id ?? null,
      }),
    onSuccess: () => {
      setBlockOpen(false);
      pushToast("Blocked — the reason is on the board.");
      refresh();
      goToNext(nextOpening ? new Date().toISOString() : null);
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const assign = useMutation({
    mutationFn: async (windowUuid: string) =>
      assignWindowToOpening(openingId, windowUuid),
    onSuccess: () => {
      setMessage("Window assigned.");
      setScanOpen(false);
      setSearch("");
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  // Any scanned label (window id / short code / serial) resolves to one unit,
  // which we then assign to this opening. A slot label is nudged back.
  const assignFromScan = async (payload: QrPayload) => {
    try {
      const res = await resolveWindowFromScan(payload, windowLookups);
      if (res.status === "ok") {
        assign.mutate(res.unit.id);
      } else if (res.status === "not-found") {
        setMessage(`No window found for "${res.query}".`);
      } else {
        setMessage("That's a slot label — scan a window label.");
      }
    } catch (e) {
      setMessage(formatApiError(e));
    }
  };

  // Typed entry accepts a 6-char code or a serial (the RPC handles both).
  const assignByCode = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    await assignFromScan({ kind: "windowCode", code: value });
  };

  const saveRo = useMutation({
    mutationFn: async () => {
      const w = smallest(roW.map((v) => Number(v)));
      const h = smallest(roH.map((v) => Number(v)));
      if (w == null || h == null) {
        throw new Error("Enter at least one width and one height measurement.");
      }
      await setRoughOpening(openingId, w, h, {
        judgments: roJudge,
        diagonals: roDiag,
        widths: roW,
        heights: roH,
      });

      // The checklist's teeth: a Bad tap - or numbers that prove a problem
      // even under a Good tap - files ONE framing issue, labeled with the
      // window, deduped against an open one so re-saving never spams the
      // framer's list.
      const failures = roFailures(roChecklist, roJudge);
      const existing = await listProjectIssues(projectId);
      const openFraming = existing.filter(
        (i) => i.opening_id === openingId && i.kind === "framing" && i.status === "open",
      );
      if (failures.length === 0) {
        // The full circle: framing fixed, checklist re-run all good - the
        // issue closes itself instead of waiting for someone to remember.
        for (const i of openFraming) await resolveIssue(i.id);
        return { filed: false, resolved: openFraming.length > 0 };
      }
      if (openFraming.length === 0) {
        await createIssue({
          projectId,
          openingId,
          kind: "framing",
          urgency: "urgent",
          note: framingIssueNote(opening.data?.opening_code ?? "?", failures, roJudge),
        });
      }
      return { filed: openFraming.length === 0, resolved: false };
    },
    onSuccess: (r) => {
      setMessage(
        r.filed
          ? "Rough opening saved — framing issue filed for this window."
          : r.resolved
            ? "Rough opening saved — all good, framing issue resolved."
            : "Rough opening saved.",
      );
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["projectIssues", projectId] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const saveCondition = useMutation({
    mutationFn: (condition: "ok" | "damaged") =>
      setOpeningCondition(openingId, condition, conditionNote || null),
    onSuccess: (_data, condition) => {
      setMessage(condition === "damaged" ? "Marked damaged — office flagged." : "Condition OK.");
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const flag = useMutation({
    mutationFn: (note: string | null) => flagOpening(openingId, note),
    onSuccess: (_d, note) => {
      setMessage(note ? "Flagged to your lead." : "Flag cleared.");
      setFlagText("");
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const postJobNote = useMutation({
    mutationFn: (note: string) => addJobNote(projectId, note),
    onSuccess: () => {
      setMessage("Site note sent to the lead.");
      setJobNoteText("");
    },
    onError: (e) => setMessage(formatApiError(e)),
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
    onError: (e) => setMessage(formatApiError(e)),
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
    onError: (e) => setMessage(formatApiError(e)),
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
      setMessage(`Mic unavailable: ${formatApiError(e)}`);
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
            minutes: submittedMinutes,
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
          // The chain target rides in the finish itself (server-side
          // hand-off, spec .scratch/sessions).
          nextOpeningId: nextOpening?.id ?? null,
          minutes: submittedMinutes,
          estimateMinutes: brain.data?.medianMinutes
            ? Math.round(brain.data.medianMinutes)
            : null,
          qualityGrade: grade,
          startedAt,
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
      // This opening is finished; its start must not be waiting on the device
      // to be picked up again if they ever revisit it.
      forgetLocalStart(openingId);
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
    onError: (e) => setMessage(formatApiError(e)),
  });

  // Lunch/Break: start a shift break (so shift-time and task-time reconcile),
  // then head to the clock. If not clocked in, just route to the clock.
  const takeBreak = useMutation({
    mutationFn: async () => {
      const shift = clock.shift ?? (myProfile.data?.id
        ? await getOpenShift(myProfile.data.id)
        : null);
      if (shift) await startBreak(shift.id);
    },
    onSettled: () => navigate("/clock"),
  });

  const o = opening.data;
  if (opening.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  // Not "Opening not found." — a re-extract replaces every opening row, and the
  // person hitting this is usually standing at the window it used to name.
  if (!o) return <OpeningMoved projectId={projectId} openingId={openingId} />;

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
      {/* The chain banner: the clock is already on this window; for five
          minutes the hand-off stays redirectable (spec .scratch/sessions). */}
      {chainGraceLeft > 0 && (
        <div
          className="detail-card"
          role="status"
          style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}
        >
          <span aria-hidden>⛓️</span>
          <span style={{ flex: 1 }}>
            Clock's on <strong>{opening.data?.opening_code ?? "this window"}</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {" "}· redirectable {Math.ceil(chainGraceLeft / 60000)}m
            </span>
          </span>
          <button className="button-like" onClick={() => setChainPickerOpen((v) => !v)}>
            Change window
          </button>
        </div>
      )}
      {chainPickerOpen && chainGraceLeft > 0 && (
        <div className="detail-card" style={{ marginBottom: 8 }}>
          <span className="field-label">Where are you actually headed?</span>
          <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 6 }}>
            {(myOpenings.data ?? [])
              .filter((o) => o.id !== openingId && o.status !== "installed")
              .slice(0, 12)
              .map((o) => (
                <button
                  key={o.id}
                  className="button-like studio-mini"
                  disabled={redirectChain.isPending}
                  onClick={() => redirectChain.mutate(o.id)}
                >
                  {o.opening_code}
                </button>
              ))}
          </div>
        </div>
      )}

      <header className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <BackChip fallback={`/projects/${projectId}?tab=map`} label="Back to map" />
          <h1 className="opening-code-title">{o.opening_code}</h1>
        </div>
        <Link to={`/projects/${projectId}?tab=map`} className="button-like">
          Map
        </Link>
      </header>

      {movedFrom && (
        <p className="muted">
          The office reloaded the plans, so {movedFrom} has a new entry. This is
          it — nothing you recorded is lost.
        </p>
      )}

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

      {openingSpec ? (
        <SpecCard spec={openingSpec} projectId={projectId} />
      ) : (
        // Only once the sheet HAS been read and this mark still isn't in it —
        // a project with no specs at all simply hasn't had them uploaded yet,
        // and saying "no spec sheet for this mark" there would be a lie.
        (markSpecs.data?.length ?? 0) > 0 && (
          <MissingSpecNotice
            projectId={projectId}
            openingCode={opening.data?.opening_code}
          />
        )
      )}

      {message && (
        <p className={/^(Window|Install|Rough|Condition|Flag|Flagged|Site|Complication)/.test(message) ? "ok" : "error"}>
          {message}
        </p>
      )}

      {/* Start-of-task gate: you can't be "on a task" unless you're clocked in
          and have signed today's toolbox talk. Shown up front rather than after
          a failed call, and read from the same `eligibility` the timer obeys —
          this banner used to sit above a running clock. */}
      {!installed && (eligibility.status === "blocked" || startGateError) && (
        <div className="ready-banner ready-blocked">
          <strong>Not on the clock yet</strong>
          <ul>
            {eligibility.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p style={{ margin: "6px 0 10px" }}>
            {startGateError ??
              "Clock in and sign today's toolbox talk, then start this window."}
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            {/* The clock is a sheet over this screen, so they punch in and
                start the window without losing their place. */}
            <button className="primary" onClick={clock.openClock}>
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

      {/* --- INSTALLED: the done card, and the honest way back --- */}
      {installed && (
        <div className="detail-card">
          <p className="ok" style={{ margin: 0, fontWeight: 700 }}>Installed ✓</p>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            Forgot something, or need a fix? Undoing keeps every record — the
            memo, photos, grade and minutes stay on file — and puts this window
            back on the install list with a required note saying why.
          </p>
          {isForemanPlus(effectiveRole) ? (
            !undoOpen ? (
              <button
                className="button-like"
                style={{ marginTop: 8 }}
                onClick={() => setUndoOpen(true)}
              >
                Send it back — undo this install
              </button>
            ) : (
              <>
                <label className="field-label" style={{ marginTop: 8 }}>
                  Why is it coming back off the wall? (required — goes on the
                  record and opens a fix-it issue)
                </label>
                <textarea
                  rows={2}
                  maxLength={500}
                  value={undoReason}
                  placeholder="e.g. forgot the sill shims / scratched pane, needs a swap"
                  onChange={(e) => setUndoReason(e.target.value)}
                />
                <div className="row-gap" style={{ marginTop: 8 }}>
                  <button
                    className="button-like active-pill"
                    disabled={undo.isPending || undoReason.trim() === ""}
                    onClick={() => undo.mutate()}
                  >
                    {undo.isPending ? "Undoing…" : "Undo install — keep all records"}
                  </button>
                  <button
                    className="button-like"
                    disabled={undo.isPending}
                    onClick={() => {
                      setUndoOpen(false);
                      setUndoReason("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )
          ) : (
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
              Ask your foreman to send it back — undoing an install is their call.
            </p>
          )}
        </div>
      )}

      {/* REDO (CONTEXT.md): the install was REAL but the window needs doing
          again — different truth than undo, so a different button. Any
          installer, reason required; the foreman is notified, never asked.
          The original record stands; the window goes back in play. */}
      {installed && (
        <div className="detail-card">
          {!redoSheetOpen ? (
            <button className="button-like" onClick={() => setRedoSheetOpen(true)}>
              🔁 Redo this window — it needs doing again
            </button>
          ) : (
            <>
              <label className="field-label">
                Why does it need redoing? (required — your foreman gets pinged,
                the window goes back on the list)
              </label>
              <textarea
                rows={2}
                maxLength={500}
                value={redoReason}
                placeholder="e.g. failed inspection / glass fogged / wrong unit went in"
                onChange={(e) => setRedoReason(e.target.value)}
              />
              <div className="row-gap" style={{ marginTop: 8 }}>
                <button
                  className="button-like active-pill"
                  disabled={doRedo.isPending || redoReason.trim() === ""}
                  onClick={() => doRedo.mutate()}
                >
                  {doRedo.isPending ? "Filing…" : "Redo — put it back in play"}
                </button>
                <button
                  className="button-like"
                  disabled={doRedo.isPending}
                  onClick={() => {
                    setRedoSheetOpen(false);
                    setRedoReason("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Past undos stay visible on ANY status — the why is the point. */}
      {(undoHistory.data?.length ?? 0) > 0 && (
        <div className="detail-card">
          <span className="field-label">Previously sent back</span>
          <ul className="unit-list" style={{ marginTop: 4 }}>
            {(undoHistory.data ?? []).map((u) => (
              <li key={u.id} className="muted" style={{ fontSize: 12.5 }}>
                {u.voided_at &&
                  new Date(u.voided_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}{" "}
                · {u.voider?.display_name ?? "lead"} — “{u.void_reason ?? "no reason recorded"}”
                {u.minutes != null && ` · ${u.minutes}m install kept on file`}
              </li>
            ))}
          </ul>
        </div>
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
                <span title="9 out of 10 installs of this type finish faster than this">
                  <strong>
                    {brain.data?.p90Minutes != null
                      ? `${Math.round(brain.data.p90Minutes)}m`
                      : "—"}
                  </strong>
                  slow case
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
              onScan={(payload) => void assignFromScan(payload)}
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
            Check in order: square, then width, then height. Tap Good or Bad,
            then put the tape on it — the numbers are judged against this
            window ({"\u2265"}1/8" and {"\u2264"}1/2" over the unit), and a
            failed check files a framing issue by itself.
          </p>

          {([
            {
              id: "square" as RoCheckId,
              title: "Square?",
              how: "Measure both diagonals of the X — they should match.",
              inputs: (
                <div className="ro-row">
                  {roDiag.map((v, i) => (
                    <input
                      key={i}
                      type="number"
                      inputMode="decimal"
                      step="0.0625"
                      value={v}
                      placeholder={["diagonal 1", "diagonal 2"][i]}
                      onChange={(e) => {
                        const next = [...roDiag];
                        next[i] = e.target.value;
                        setRoDiag(next);
                      }}
                    />
                  ))}
                </div>
              ),
            },
            {
              id: "width" as RoCheckId,
              title: "Width?",
              how: "Across the top and bottom (and middle) — smallest wins.",
              inputs: (
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
              ),
            },
            {
              id: "height" as RoCheckId,
              title: "Height?",
              how: "Down the left and right sides — smallest wins.",
              inputs: (
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
              ),
            },
          ]).map((row) => {
            const verdict = roChecklist.find((v) => v.check === row.id);
            const judged = roJudge[row.id];
            const disagree = judged === "good" && verdict?.measured === "bad";
            return (
              <div key={row.id} className="ro-check">
                <div className="ro-check-head">
                  <RoDiagram kind={row.id} />
                  <div className="ro-check-title">
                    <strong>{row.title}</strong>
                    <span className="muted">{row.how}</span>
                  </div>
                  <div className="ro-judge" role="group" aria-label={row.title}>
                    <button
                      type="button"
                      className={judged === "good" ? "ro-pill good on" : "ro-pill good"}
                      onClick={() =>
                        setRoJudge((j) => ({ ...j, [row.id]: j[row.id] === "good" ? null : "good" }))
                      }
                    >
                      Good ✓
                    </button>
                    <button
                      type="button"
                      className={judged === "bad" ? "ro-pill bad on" : "ro-pill bad"}
                      onClick={() =>
                        setRoJudge((j) => ({ ...j, [row.id]: j[row.id] === "bad" ? null : "bad" }))
                      }
                    >
                      Bad ✕
                    </button>
                  </div>
                </div>
                {judged !== null && (
                  <>
                    {row.inputs}
                    {verdict?.detail && (
                      <p
                        className={
                          verdict.measured === "bad" ? "ro-verdict bad" : "ro-verdict"
                        }
                      >
                        {verdict.measured === "bad" ? "✕ " : verdict.measured === "good" ? "✓ " : ""}
                        {verdict.detail}
                        {disagree && " — the tape disagrees with your Good; this files as framing."}
                      </p>
                    )}
                  </>
                )}
              </div>
            );
          })}

          <button
            className="action-btn"
            disabled={saveRo.isPending}
            onClick={() => saveRo.mutate()}
          >
            {saveRo.isPending
              ? "Saving…"
              : roFailures(roChecklist, roJudge).length > 0
                ? "Save — files a framing issue for this window"
                : "Save rough opening"}
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

          {/* Before photo — captured HERE, while "before" still exists. By the
              old flow's step 3 the original window was already in the dumpster
              and every "before" was really a "during". Starting the install
              requires it; Capture keeps a retake slot for bad first shots. */}
          {!startedAt && (
            <>
              <h2 style={{ marginBottom: 2 }}>Before photo</h2>
              <p className="muted" style={{ marginTop: 0 }}>
                The opening as you found it — required before the clock starts.
              </p>
              <PhotoCaptureSheet
                mode="beforeAfter"
                slots={["before"]}
                value={photos}
                onChange={setPhotos}
                label={o.opening_code}
              />
            </>
          )}

          {/* Flashing is the FLASH RUN's job now (owner, 2026-08-14): the
              sheet only reports status — the clock, photo and submit live
              on the dispatched run. The install gate below still holds. */}
          {o.needs_flashing === true && (
            <div className="detail-card" style={{ marginTop: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="field-label" style={{ margin: 0 }}>Flashing</span>
                {flashing?.status === "submitted" ? (
                  <span className="ok" style={{ fontSize: 12.5 }}>
                    ✓ done · {flashing.submitter?.display_name ?? "crew"}
                    {flashing.minutes != null && ` · ${flashing.minutes}m`}
                  </span>
                ) : flashing ? (
                  <span style={{ fontSize: 12.5, color: "var(--warn, #e8c14a)", fontVariantNumeric: "tabular-nums" }}>
                    {flashing.paused_at ? "paused" : "flashing"} ·{" "}
                    {formatPhaseClock(phaseElapsedSeconds(flashing, now))}
                    {flashing.starter?.display_name && ` · ${flashing.starter.display_name}`}
                  </span>
                ) : (
                  <span className="muted" style={{ fontSize: 12.5 }}>required before install</span>
                )}
                {isForemanPlus(effectiveRole) && flashing?.status !== "submitted" && (
                  <button
                    className="link"
                    style={{ marginLeft: "auto", fontSize: 12 }}
                    disabled={toggleNeedsFlashing.isPending}
                    onClick={() => toggleNeedsFlashing.mutate(false)}
                  >
                    Doesn't need flashing
                  </button>
                )}
              </div>
              {!flashing && (
                <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                  Flashing happens on the flash run — your foreman dispatches it.
                </p>
              )}
            </div>
          )}
          {o.needs_flashing === false && isForemanPlus(effectiveRole) && (
            <p className="muted" style={{ fontSize: 12 }}>
              No flashing required here.{" "}
              <button className="link" onClick={() => toggleNeedsFlashing.mutate(true)}>
                Require it
              </button>
            </p>
          )}

          {/* A live summon shows HERE too: helpers answering the ring land
              on this stage, not the caller's install screen. */}
          <SummonPanel
            projectId={projectId}
            openingId={openingId}
            openingCode={o.opening_code}
            widthIn={o.window_types?.width_in ?? openingSpec?.width_in ?? null}
            heightIn={o.window_types?.height_in ?? openingSpec?.height_in ?? null}
            myProfileId={myProfile.data?.id ?? null}
            myName={myProfile.data?.display_name ?? null}
            effectiveRole={effectiveRole ?? "installer"}
            installRunning={false}
          />

          {/* The deliberate act. This is the moment the clock starts — and the
              moment the lead board sees this window as in progress. */}
          <button
            className="primary big"
            disabled={
              ready.status === "blocked" ||
              beginInstall.isPending ||
              flashingBlocked ||
              (!startedAt && photos.before === null) ||
              (!startedAt && !canStartInstall(eligibility.status))
            }
            onClick={() => (startedAt ? setStage("install") : beginInstall.mutate())}
          >
            {ready.status === "blocked"
              ? "Resolve blockers to start"
              : flashingBlocked
                ? "Flash this opening first"
                : !startedAt && photos.before === null
                  ? "Take the before photo to start"
                  : eligibility.status === "blocked"
                    ? "Clock in first to start"
                    : startedAt
                      ? "Back to the install →"
                      : beginInstall.isPending
                        ? "Starting…"
                        : "Start install →"}
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

      {/* ===================== STAGE 2: INSTALL =====================
          Four distinct states, and only one of them counts. Landing on this
          step is not starting: the clock runs when they say it does. */}
      {!installed && stage === "install" && (
        <div className="install-timer">
          {timer.status === "running" || timer.status === "stale" ? (
            <>
              <div className="install-pulse" aria-hidden>
                ●
              </div>
              <p className="next-label" style={{ margin: 0 }}>Installing</p>
              {timer.status === "running" ? (
                <>
                  <p className="next-code">
                    {timer.minutes}
                    <span style={{ fontSize: 28 }}> min</span>
                  </p>
                  <p className="muted" style={{ margin: 0 }}>
                    Timer running. Plumb, level, square — then capture it.
                  </p>
                </>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  This has been open since{" "}
                  {startedAt ? new Date(startedAt).toLocaleString() : "a while ago"},
                  so the timer stopped guessing. Type the real minutes when you
                  capture it.
                </p>
              )}
              {tips.length > 0 && (
                <ol className="tip-list" style={{ textAlign: "left", width: "100%" }}>
                  {tips.slice(0, 3).map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ol>
              )}
              <SummonPanel
                projectId={projectId}
                openingId={openingId}
                openingCode={o.opening_code}
                widthIn={o.window_types?.width_in ?? openingSpec?.width_in ?? null}
                heightIn={o.window_types?.height_in ?? openingSpec?.height_in ?? null}
                myProfileId={myProfile.data?.id ?? null}
                myName={myProfile.data?.display_name ?? null}
                effectiveRole={effectiveRole ?? "installer"}
                installRunning
              />
              <button className="primary big" onClick={() => setStage("capture")}>
                Done — capture it →
              </button>
              {/* BLOCK: the first-class exit — stuck through no fault of
                  yours. Reason required; the blocker issue files itself;
                  the clock hands off exactly like Finish. */}
              <button
                className="button-like"
                style={{ marginTop: 8 }}
                onClick={() => setBlockOpen((v) => !v)}
              >
                🚫 Blocked — can't continue
              </button>
              {blockOpen && (
                <div className="detail-card" style={{ marginTop: 8, textAlign: "left" }}>
                  <span className="field-label">What's stopping you?</span>
                  <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 6 }}>
                    {BLOCK_REASONS.map((r) => (
                      <button
                        key={r}
                        className="button-like studio-mini"
                        disabled={doBlock.isPending}
                        onClick={() => doBlock.mutate(r)}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  <div className="row-gap" style={{ marginTop: 8 }}>
                    <input
                      style={{ flex: 1, minWidth: 0 }}
                      placeholder="Something else — say what"
                      value={blockOther}
                      onChange={(e) => setBlockOther(e.target.value)}
                    />
                    <button
                      className="button-like"
                      disabled={doBlock.isPending || !blockOther.trim()}
                      onClick={() => doBlock.mutate(blockOther.trim())}
                    >
                      Block
                    </button>
                  </div>
                  {nextOpening && (
                    <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
                      The clock hands off to {nextOpening.opening_code} — same as
                      finishing.
                    </p>
                  )}
                </div>
              )}
            </>
          ) : timer.status === "blocked" ? (
            <>
              <p className="next-label" style={{ margin: 0 }}>Not started</p>
              <p className="muted" style={{ margin: 0 }}>
                Nothing is being timed. Clock in and sign today's toolbox talk,
                then start this window.
              </p>
              <button className="primary big" onClick={clock.openClock}>
                Clock in
              </button>
            </>
          ) : timer.status === "unknown" ? (
            <p className="muted" style={{ margin: 0 }}>Checking your clock…</p>
          ) : (
            <>
              <p className="next-label" style={{ margin: 0 }}>Ready when you are</p>
              <p className="muted" style={{ margin: 0 }}>
                Nothing is being timed yet. Tap start when you actually begin
                fitting this one.
              </p>
              <button
                className="primary big"
                disabled={beginInstall.isPending}
                onClick={() => beginInstall.mutate()}
              >
                {beginInstall.isPending ? "Starting…" : "Start the timer"}
              </button>
            </>
          )}
        </div>
      )}

      {/* ===================== STAGE 3: CAPTURE ===================== */}
      {!installed && stage === "capture" && (
        <>
          <h2>Photos</h2>
          {/* The before was captured in step 1 (owner, 2026-08-14: no
              double-ask) — this stage only takes the after, lined up over
              the ghosted before. */}
          <p className="muted">The after lines up over the before you took in step 1.</p>
          <PhotoCaptureSheet
            mode="beforeAfter"
            slots={["after"]}
            value={photos}
            onChange={setPhotos}
            label={o.opening_code}
          />

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

          {/* The hand-typed era is over (spec .scratch/sessions): minutes
              are derived server-side from this window's sessions — breaks
              and lunches never count, and nobody argues with a stopwatch. */}
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            Time records itself from your sessions
            {timer.minutes != null ? ` — about ${timer.minutes} min so far` : ""}.
            Breaks never count.
          </p>

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

          {submitBlockedBy && (
            <p className="muted" role="status">{submitBlockedBy}</p>
          )}

          <button
            className="primary big"
            disabled={
              submit.isPending ||
              recording ||
              ready.status === "blocked" ||
              submitBlockedBy !== null
            }
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
                goToNext(nextOpening ? new Date().toISOString() : null);
              }}
            >
              {nextOpening ? (
                <>
                  Next one →{" "}
                  <span style={{ opacity: 0.85 }}>
                    {nextOpening.opening_code} — clock's already on it
                  </span>
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
 * navigates within the same route) fully remounts the component — the stage and
 * all per-opening state reset for a clean sub-5s transition.
 *
 * The timer is no longer among the things a remount resets, and must not be.
 * It reads `work_started_at` for THIS opening (server-stamped, falling back to
 * this device's own note of the start), so the next window opens un-started
 * while a refresh part-way through an install keeps every minute already
 * earned. Mount time is not a start time — treating it as one is what made
 * reading a door's specs bill an installer for an install.
 */
export function OpeningSheetRoute() {
  const { openingId = "" } = useParams();
  return <OpeningSheet key={openingId} />;
}
