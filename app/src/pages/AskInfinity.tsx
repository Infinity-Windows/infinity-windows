import {useQuery} from "@tanstack/react-query";
import {getRealProfile} from "../lib/install/api";
import {LearningPanel} from "../components/hexPortal/LearningPanel";
import {LearningCard} from "../components/hexPortal/LearningCard";
import {LearningReviewForm} from "../components/hexPortal/LearningReviewForm";
import {findPortalGuidance,type PortalSource,type LearningDraft} from "../lib/hexPortal";
import { clearPortalGuidanceCache, forgetVerifiedGuidance, readOfflineGuidance, rememberVerifiedGuidance } from "../lib/hexPortalCache";
import "../components/hexPortal/hexPortal.css";
import type { AskArtifact } from "../../../supabase/functions/_shared/askReporting.ts";
import { ReportCard } from "../components/ask/ReportCard";
import { AiIssueReport } from "../components/ask/AiIssueReport";
import { asksForReport, isOperationalAsk } from "../lib/askRouting";
import { cleanAskText } from "../lib/cleanAskText";
import { BackChip } from "../components/BackChip";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { supabaseConfigured } from "../lib/supabase";
import { queryClient } from "../lib/queryClient";
import { useAskSessionActor } from "../lib/useAskSessionActor";
import { askInfinity, liveAnswer, shouldUseLLM, type AskLiveData, type KnowledgeSource } from "../lib/knowledge";
import { askBrain, getBrainIndex, type BrainOutcome } from "../lib/brain/answer";
import { currentCatalog, refreshCatalogCache } from "../lib/brain/catalogCache";
import { logAskedQuestion } from "../lib/brain/askLog";
import type { BrainHit, CatalogType } from "../lib/brain/types";
import type { Profile, ProjectOpening } from "../lib/install/types";
import type { Project } from "../lib/types";
import type { Issue } from "../lib/issues";
import type { ScheduleAssignment } from "../lib/schedule/types";
import type { ScheduleVehicleLink, VehicleWithMeta } from "../lib/vehicles/types";
import type { Trip } from "../lib/travel/types";
import { useLanguage } from "../lib/i18n";
import { useFieldT as useT } from "../components/ask/fieldCatalog";
import { FieldChecklist, FieldReceiptCard } from "../components/ask/FieldCards";
import {
  currentConversation, dropUnsent, FIELD_QUERY_ROOTS, keepUnsent, listUnsent, loadConversation, memoPlaybackUrl, phoneTimingPending,
  readClockVersion, readPhoneTimingState, runVoiceSteps, sessionUserIs, startNewConversation, uploadMemo, type FieldMeta, type FieldReceipt, type FieldReply, type PhoneTimingState, type UnsentField,
} from "../lib/fieldAsk";
import { pendingClockWrites } from "../lib/offline/outbox";
import { readWorkQueue } from "../lib/customWork/queue";
import { startVoiceRecording, type VoiceRecording } from "../lib/voiceRecording";
import { transcribeDescription } from "../lib/dictation";
import { useUnsavedWorkWhile } from "../lib/pwa/useUnsavedWork";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Mic, Radio, Square } from "lucide-react";
import { inBand, isTextEntry, readingHistory, revealDelta, revealTarget, scrollPageBy, spanOf, unionSpan, visibleBand, type Span } from "../lib/askLatest";
import { readCardsHidden, rememberCardsHidden } from "../lib/askCardsPref";
import type { TimeShift } from "../lib/timeclock";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { roleRank } from "../lib/install/types";
import { listWorkSessions, listWorkUnits } from "../lib/customWork/api";
import { ActionCards, AllActions, type CardPick, type RunningUnit } from "../components/ask/ActionCards";
import { contextTagFromInput, type AskContextTag } from "../../../supabase/functions/_shared/fieldTools";
import { readClockButtons, type ClockButton } from "../../../supabase/functions/_shared/clockButtons";
import { ClockButtons } from "../components/ask/ClockButtons";
import { NavigationButton } from "../components/ask/NavigationButton";
import { readNavigationAction, type NavigationAction } from "../../../supabase/functions/_shared/askNavigation";
import { askClockHandoff, type AskClockHandoff } from "../lib/askClockHandoff";
import { needsNothingSavedNotice } from "../lib/askReceiptGuard";
import { AiDailyLogCard } from "../components/aiDailyLogs/AiDailyLogCard";
import { useAiDailyLogDraft } from "../lib/aiDailyLogs/useAiDailyLogDraft";
import { applyDailyLogReply, asksForDailyLog, dailyLogContextForMessage } from "../lib/aiDailyLogs/askBridge";
import { signedInEmail } from "../lib/signedIn";
import { startLiveSession, type LiveEndReason, type LiveSession, type LiveStatus, type LiveTurn } from "../lib/liveAskSession";
import { liveCommentary, type LiveTurnOutcome } from "../lib/liveAskCommentary";
import { canContinueLive, liveAskPilotEnabled, liveStatusLine, liveText } from "../lib/liveAskPilot";

export interface LiveAskShellState {
  status: LiveStatus;
  detail?: LiveEndReason | string;
  saving: boolean;
  needsClock: boolean;
  clockHandoff: AskClockHandoff | null;
  muted: boolean;
  expiring: boolean;
  navigation: NavigationAction | null;
}
export interface LiveAskShellControls { end(): void; toggleMute(): void; restart(): void }

// Every cached screen a field receipt may have changed (see FIELD_QUERY_ROOTS).
const refreshFieldViews = () => { for (const root of FIELD_QUERY_ROOTS) void queryClient.invalidateQueries({ queryKey: [root] }); };

interface ChatMsg {
  reportChannel?: "text" | "live";
  /** Field work: database receipts and the checklist, never model claims. */
  field?: FieldReply;
  /** One-tap job-clock buttons the reply offered (K2.4): the tap is the change. */
  buttons?: ClockButton[];
  navigation?: NavigationAction;
  /** The reply filled a draft on this phone (a lesson write-up, a daily log). */
  draftApplied?: boolean;
  /** The reply's daily-log answers had no saved message behind them: NOT recorded. */
  dailyNotRecorded?: boolean;
  /** The saved original recording behind this message. */
  memoPath?: string | null;
  /** The field request this message was, so a reload never shows it twice. */
  requestId?: string;
  learning?: LearningDraft;
  portalSources?: PortalSource[];
  portalNotice?: string;
  cachedGuidance?: boolean;
  artifacts?: AskArtifact[];
  who: "me" | "infinity";
  text: string;
  /** Citations from the cloud path. */
  sources?: KnowledgeSource[];
  /** Answers from the local brain, each with where it came from. */
  hits?: BrainHit[];
  /** Wave A4: plain progress lines for any scheduling tools the model called
   * ("Reading the week…", "Drafting 6 assignments…"), shown above the answer. */
  toolActivity?: string[];
}

/**
 * Ask Infinity — the company's own written knowledge, looked up on the phone.
 *
 * Answers come from a keyword index over content the company already owns: the
 * glossary, the install procedure, and the tips and watch-outs seeded on the
 * real window catalog. It runs entirely on the device, costs nothing per
 * question, needs no API key, and works in a basement with no signal. Because it
 * only ever shows sentences a human wrote, it physically cannot invent a
 * flashing sequence.
 *
 * Live job questions ("my next window", "our schedule") still come from the
 * app's own cached data, and the cloud AI is used only when it is configured —
 * never as a prerequisite for a correct answer.
 */

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Union the rows of every matching cached query, de-duped by id. */
function mergeCached<T extends { id: string }>(
  groups: Array<[readonly unknown[], T[] | undefined]>,
): T[] {
  const byId = new Map<string, T>();
  for (const [, rows] of groups) {
    for (const row of rows ?? []) byId.set(row.id, row);
  }
  return [...byId.values()];
}

/**
 * Assemble the live snapshot the offline fallback reads from — straight out of
 * the app's TanStack Query cache, scoped to the signed-in user's role/profile.
 * Cold entries are left null so the fallback degrades to the static brain.
 */
function gatherLiveData(): AskLiveData {
  const profile = queryClient.getQueryData<Profile>(["myProfile"]);
  const openings = mergeCached(
    queryClient.getQueriesData<ProjectOpening[]>({ queryKey: ["myOpenings"] }),
  );
  const schedule = mergeCached(
    queryClient.getQueriesData<ScheduleAssignment[]>({ queryKey: ["mySchedule"] }),
  );
  const issues = mergeCached([
    ...queryClient.getQueriesData<Issue[]>({ queryKey: ["issues"] }),
    ...queryClient.getQueriesData<Issue[]>({ queryKey: ["projectIssues"] }),
  ]);
  const projects = queryClient.getQueryData<Project[]>(["projects"]);
  const vehicles =
    queryClient.getQueryData<VehicleWithMeta[]>(["vehicles"]) ??
    queryClient.getQueryData<VehicleWithMeta[]>(["notifVehicles"]);
  const scheduleVehicles = mergeCached(
    queryClient.getQueriesData<ScheduleVehicleLink[]>({ queryKey: ["myScheduleVehicles"] }),
  );
  const trips = queryClient.getQueryData<Trip[]>(["trips"]);
  return {
    role: profile?.role ?? null,
    profileId: profile?.id ?? null,
    todayISO: todayLocalISO(),
    openings: openings.length > 0 ? openings : null,
    schedule: schedule.length > 0 ? schedule : null,
    issues: issues.length > 0 ? issues : null,
    projects: projects ?? null,
    vehicles: vehicles ?? null,
    scheduleVehicles: scheduleVehicles.length > 0 ? scheduleVehicles : null,
    trips: trips ?? null,
  };
}

/** Render one brain answer as the chat bubble's text. */
function hitText(hit: BrainHit): string {
  return `${hit.entry.title}\n${hit.entry.body}`;
}

function brainMessage(outcome: BrainOutcome, note?: string): ChatMsg {
  // `note` is the one quiet line the server sends when it declined to pay for an
  // AI answer — out of questions for today, or the company's monthly budget is
  // used up. The answer below it is real either way, so the note goes above it
  // rather than replacing it. See docs/ai-spend-limits.md.
  const prefix = note ? `${note}\n\n` : "";
  if (outcome.kind === "answers") {
    return { who: "infinity", text: prefix + hitText(outcome.hits[0]), hits: outcome.hits };
  }
  return { who: "infinity", text: prefix + outcome.message };
}

/** What to bring into view (askLatest's revealTarget): the newest message with
 * "Finding an answer…" under it while that shows, and — for a reply — the
 * person's words just above it when both fit. */
function latestTarget(thread: HTMLElement | null, status: HTMLElement | null, answersMine: boolean, band: Span): Span | null {
  const rows = thread ? thread.querySelectorAll("[data-msg]") : null;
  if (!rows || !rows.length) return spanOf(status);
  const newest = unionSpan([spanOf(rows[rows.length - 1]), spanOf(status)]);
  return revealTarget(newest, answersMine && rows.length > 1 ? spanOf(rows[rows.length - 2]) : null, band);
}
const answersMine = (all: ChatMsg[]) => all.length > 1 && all[all.length - 1].who === "infinity" && all[all.length - 2].who === "me";

/** The speaker's original recording, fetched on demand through a short-lived
 * private link (the bucket is readable only by them and supervisors). */
function MemoPlayback({ path }: { path: string }) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  if (url) return <audio className="field-memo" controls src={url} />;
  return (
    <button type="button" className="chip field-memo" onClick={() => void memoPlaybackUrl(path).then(setUrl)}>
      <Mic size={13} /> {t("field.memo")}
    </button>
  );
}

/** A local draft can be heard before its Send now tap; no network request. */
function LocalMemoPlayback({ audio, label }: { audio: Blob; label: string }) {
  const url = useMemo(() => URL.createObjectURL(audio), [audio]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <audio className="field-memo" controls preload="none" src={url} aria-label={label} />;
}

export function AskInfinity({ active = true, onLiveState, registerLiveControls }: {
  active?: boolean;
  onLiveState?: (state: LiveAskShellState) => void;
  registerLiveControls?: (controls: LiveAskShellControls | null) => void;
} = {}) {
  const t = useT();
  const es = useLanguage().lang === "es";
  const profile = useQuery({queryKey:["myRealProfile"],queryFn:getRealProfile});
  const sessionActor = useAskSessionActor();
  const [learningJob,setLearningJob]=useState("");
  const [learningUnit,setLearningUnit]=useState("");
  const [input, setInput] = useState("");
  const [catalog, setCatalog] = useState<CatalogType[]>(() => currentCatalog().types);
  const [messages, setMessages] = useState<ChatMsg[]>([
    { who: "infinity", text: t("ask.greeting") },
  ]);
  const [thinking, setThinking] = useState(false);
  /** `thinking`, readable the instant it changes: a live turn queued behind
   * the previous reply calls send() before React has re-rendered. */
  const busyRef = useRef(false);
  const threadRef = useRef<HTMLDivElement>(null);
  /** "Finding an answer…" — part of the newest thing on screen while it shows. */
  const statusRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** A new message arrived while the person was reading older ones (or typing
   * elsewhere): which way it is. The page is not moved under them. */
  const [jump, setJump] = useState<"up" | "down" | null>(null);
  const location = useLocation();
  // Action cards (K2.2): what the UI shows follows the effective role (an
  // owner previewing "installer" sees installer cards), while every message
  // is still sent as the real account — the cards only choose words.
  const { effectiveRole } = useEffectiveRole();
  const cardRank = roleRank(effectiveRole);
  const [showAll, setShowAll] = useState(false);
  /** The action cards are put away (see "Action cards" below). */
  const [cardsHidden, setCardsHidden] = useState(false);
  // Context tag (K2.3): the job (and maybe unit) Ask was opened from. Read
  // through a ref inside send(), which closes over an older render.
  const [tag, setTag] = useState<AskContextTag | null>(null);
  const tagRef = useRef<AskContextTag | null>(null);
  tagRef.current = tag;
  const lastActor = useRef<string | null | undefined>(undefined);

  // --- Field work -----------------------------------------------------------
  // Everything below is scoped to the REAL signed-in account (not "view as"):
  // another person signing in on this phone sees none of it.
  const userId = profile.data?.id === sessionActor ? sessionActor : null;
  const [conversation, setConversation] = useState<string | null>(null);
  // Daily log through Ask (K2.7). The controller is bound to the REAL
  // signed-in person (never a role preview); the card shows while a draft is
  // being built here, and `logOpenRef` is what send()/run() read, because
  // they close over an older render.
  const logs = useAiDailyLogDraft(userId && profile.data ? { userId, email: signedInEmail(), displayName: profile.data.display_name ?? null } : null);
  const [logOpen, setLogOpen] = useState(false);
  const logOpenRef = useRef(false);
  const [unsent, setUnsent] = useState<UnsentField[]>([]);
  const retryingUnsent = useRef(new Set<string>());
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [voice, setVoice] = useState<"idle" | "starting" | "recording" | "saving" | "transcribing">("idle");
  // Live Ask (pilot, lib/liveAskSession.ts): a spoken conversation whose every
  // finished utterance is saved as a memo and then sent through send() below.
  // Pilot builds offer this only to the real owner login. The server repeats
  // the role check, so a client-side switch cannot enroll other crew.
  const livePilot = liveAskPilotEnabled() && profile.data?.role === "owner";
  const [live, setLive] = useState<{ status: LiveStatus; detail?: LiveEndReason | string }>({ status: "idle" });
  const liveRef = useRef<LiveSession | null>(null);
  const restartLiveRef = useRef<() => void>(() => {});
  const liveOn = live.status === "starting" || live.status === "live" || live.status === "unstable";
  const [liveIssue, setLiveIssue] = useState<{ question: string; answer: string } | null>(null);
  useEffect(() => { setLiveIssue(null); }, [userId]);
  const [liveMuted, setLiveMuted] = useState(false);
  const [liveExpiring, setLiveExpiring] = useState(false);
  const [liveNavigation, setLiveNavigation] = useState<NavigationAction | null>(null);
  /** Live turns cut from the microphone and not yet sent or kept on the phone. */
  const [liveSaving, setLiveSaving] = useState(0);
  const clockHandoff = useMemo((): AskClockHandoff | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const field = messages[i].field;
      for (let j = (field?.receipts.length ?? 0) - 1; j >= 0; j--) {
        const handoff = askClockHandoff(field!.receipts[j], field!.draft);
        if (handoff) return handoff;
      }
    }
    return null;
  }, [messages]);
  const needsClock = !!clockHandoff;
  useEffect(() => {
    onLiveState?.({ status: live.status, detail: live.detail, saving: liveSaving > 0, needsClock, clockHandoff, muted: liveMuted, expiring: liveExpiring, navigation: liveNavigation });
  }, [live.status, live.detail, liveSaving, needsClock, clockHandoff, liveMuted, liveExpiring, liveNavigation, onLiveState]);
  useEffect(() => {
    if (!registerLiveControls) return;
    registerLiveControls({
      end: () => liveRef.current?.end("user"),
      restart: () => restartLiveRef.current(),
      toggleMute: () => {
        const session = liveRef.current;
        if (!session) return;
        session.setMuted(!session.muted);
        setLiveMuted(session.muted);
      },
    });
    return () => registerLiveControls(null);
  }, [registerLiveControls]);
  /** While the microphone is on — asking, recording, saving, writing it out —
   * the composer is the recorder and is pinned to the bottom of the screen
   * (see the dock below). Read through a ref by effects that measure it. */
  const pinned = voice !== "idle" || liveOn;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  // Reserve the dock's actual height, including live/recording status rows.
  // The final message/action can then scroll into the reading gap above it.
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const page = dock?.closest<HTMLElement>(".ask-page");
    if (!dock || !page) return;
    const measure = () => page.style.setProperty("--ask-dock-height", `${Math.ceil(dock.getBoundingClientRect().height)}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);
  // The phone composer is always visible, even between recordings. Replies
  // must land above it rather than behind it; desktop keeps the old band when
  // the composer is in normal page flow.
  const askBand = () => {
    const dock = dockRef.current;
    return visibleBand(dock && (pinnedRef.current || window.getComputedStyle(dock).position === "fixed") ? dock : null);
  };
  const [seconds, setSeconds] = useState(0);
  const [voiceError, setVoiceError] = useState("");
  const [restoreError, setRestoreError] = useState(false);
  const recording = useRef<VoiceRecording | null>(null);
  const recordAbort = useRef<AbortController | null>(null);
  // Push-to-talk has no across-app indicator. Keep the old page-leave safety
  // behavior for that recorder; only the explicitly started live call travels.
  useEffect(() => {
    if (active || (voice !== "starting" && voice !== "recording")) return;
    recordAbort.current?.abort();
    recording.current?.cancel();
    recording.current = null;
    setVoice("idle");
  }, [active, voice]);
  /** A recording the phone could not keep yet: held in memory until it is
   * saved on the phone or on the server, never silently dropped. */
  const [held, setHeld] = useState<{ blob: Blob; meta: FieldMeta; interrupted?: boolean }[]>([]);
  // From asking for the microphone until the recording is kept on the phone
  // or held by a sent request, the only copy is in this component's memory —
  // and a held recording is, by definition, one the phone could NOT keep. An
  // automatic app update must not reload over any of it (independent review,
  // 2026-09-23). Released by durability or by the person, never by the mic
  // merely stopping.
  useUnsavedWorkWhile(voice !== "idle" || held.length > 0 || liveOn || liveSaving > 0);
  /** The clock version read when this message was started (typing or recording). */
  const clockSeen = useRef<number | null>(null);
  // Every async completion checks it still belongs to the account and setup it
  // started under. Signing out, another person signing in or "Start a new
  // setup" moves the generation on, so a late reply, recording or restore from
  // before can never land in (or clear) the new screen. What it saved stays
  // with the person who said it.
  const gen = useRef(0);
  const actor = useRef<string | null>(null);
  const isCurrent = (g: number) => g === gen.current;
  const readClockNow = (g = gen.current) => {
    void readClockVersion().then((v) => { if (isCurrent(g)) clockSeen.current = v; });
  };
  /** A fresh screen for `person`: their conversation's cards start as they
   * last chose on this phone (askCardsPref), not as the previous screen left them. */
  const resetFieldUi = (person: string | null, { keepInput = false }: { keepInput?: boolean } = {}) => {
    gen.current += 1;
    busyRef.current = false;
    // The microphone and speaker close with the screen they were opened on.
    liveRef.current?.end("account");
    setLiveNavigation(null);
    recordAbort.current?.abort();
    recording.current?.cancel();
    recording.current = null;
    clockSeen.current = null;
    if (!keepInput) setInput("");
    setVoice("idle"); setThinking(false); setVoiceError(""); setRestoreError(false); setHeld([]);
    setLogOpen(false); logOpenRef.current = false;
    // Words kept in the box count as typed ones (K2.2): Plan with AI's prompt
    // stays with the cards put away, instead of the cards coming back over it
    // when the account resolves (#656's kept prompt meeting #659's cards).
    setCardsHidden((person ? readCardsHidden(person) : false) || (keepInput && input.trim() !== ""));
    setShowAll(false); setJump(null);
    setMessages([{ who: "infinity", text: t("ask.greeting") }]);
    return gen.current;
  };

  useEffect(() => {
    // The first resolution of the account (nobody → somebody) is the person
    // who just arrived, not a different one, so it keeps what the arrival
    // brought along with the tag below: Scheduling's "Plan with AI" puts its
    // prompt in the box before the account resolves, and wiping it here
    // landed a supervisor on an empty Ask (nightly e2e, red since Sep 17).
    // Any later change of account still starts with an empty box.
    const g = resetFieldUi(userId, { keepInput: !lastActor.current });
    actor.current = userId;
    setUnsent([]);
    retryingUnsent.current.clear();
    setRetryingIds(new Set());
    setConversation(null);
    // The tag belongs to the person who opened Ask with it (K2.3): a
    // different account signing in on this phone starts without it. The first
    // resolution of the account (nobody → somebody) keeps it.
    if (lastActor.current && lastActor.current !== userId) setTag(null);
    lastActor.current = userId;
    if (!userId) return;
    const conv = currentConversation(userId);
    setConversation(conv);
    readClockNow(g);
    void listUnsent(userId).then((u) => { if (isCurrent(g)) setUnsent(u); }).catch(() => undefined);
    // After a reload, the conversation comes back from the database: what was
    // said, the saved answers and the CURRENT state of every receipt. Messages
    // sent while this loads stay, after the restored ones, and are not repeated.
    void loadConversation(userId, conv).then((turns) => {
      if (!isCurrent(g) || !turns.length) return;
      setMessages((m) => {
        const shown = new Set(m.map((x) => x.requestId).filter(Boolean));
        const restored: ChatMsg[] = [];
        for (const turn of turns.filter((x) => !shown.has(x.id))) {
          restored.push({ who: "me", text: turn.transcript, memoPath: turn.audio_path, requestId: turn.id });
          if (turn.reply || turn.receipts.length)
            restored.push({ who: "infinity", text: turn.reply?.answer ?? "", toolActivity: turn.reply?.toolActivity, buttons: readClockButtons(turn.reply?.buttons), navigation: readNavigationAction(turn.reply?.navigation) ?? undefined,
              artifacts: (turn.reply?.artifacts ?? []).filter((a) => a && ["time_report", "job_summary"].includes(a.kind)).slice(0, 4),
              sources: turn.reply?.sources ?? [],
              field: { request_id: turn.id, receipts: turn.receipts, checklist: turn.captured?.checklist ?? null, draft: turn.captured?.answers ?? undefined, learning: turn.captured?.learning ?? null } });
        }
        return [m[0], ...restored, ...m.slice(1)];
      });
    }).catch(() => { if (isCurrent(g)) setRestoreError(true); });
    return () => { recordAbort.current?.abort(); recording.current?.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // The running unit puts "Finish unit N" first (K2.2). Same query keys as
  // useWork, so Current Work's cache answers this without a second fetch and
  // no queue sync is started from here.
  const mySessions = useQuery({ queryKey: ["customWorkSessions", userId, "mine"], queryFn: () => listWorkSessions(undefined, userId!), enabled: !!userId });
  const myUnits = useQuery({ queryKey: ["customWorkUnits", userId, "all"], queryFn: () => listWorkUnits(undefined), enabled: !!userId });
  const running = useMemo<RunningUnit | null>(() => {
    const open = (mySessions.data ?? []).find((s) => s.profile_id === userId && !s.ended_at && s.unit_id);
    const unit = open ? (myUnits.data ?? []).find((u) => u.id === open.unit_id) : null;
    return unit ? { unitLabel: unit.label } : null;
  }, [mySessions.data, myUnits.data, userId]);

  const fieldActive = messages.some((m) => !!m.field);
  const latestChecklistIndex = messages.reduce((index, m, i) => m.field?.checklist ? i : index, -1);
  const latestChecklist = latestChecklistIndex >= 0 ? messages[latestChecklistIndex].field!.checklist : null;
  // A checklist is a conversation draft. Only a database receipt for the
  // current setup can retire it; zero missing answers alone cannot. A unit
  // sent for review still needs a person to finish that review.
  const setupSaved = !!latestChecklist && messages.slice(latestChecklistIndex).some((m) =>
    m.field?.receipts.some((r) => r.status === "done" && (
      latestChecklist.unit?.length
        ? r.action === "save_unit" && ["created", "created_from_map", "details_added", "corrected", "unchanged"].includes(r.outcome ?? "")
        : r.action === "create_job" && ["created", "used_existing"].includes(r.outcome ?? "")
    )),
  );
  // A lesson write-up Ask prepared: one card for the latest version, filed as a
  // Hex-Portal case (the person's words and the reply) only when they tap Save.
  const learningReply = [...messages].reverse().find((m) => m.field?.learning);
  const learningPrep = learningReply?.field?.learning ?? null;
  const learningWords = learningPrep ? messages.find((m) => m.who === "me" && m.requestId === learningPrep.request_id)?.text : undefined;
  const updateReceipt = (next: FieldReceipt) => {
    setMessages((all) => all.map((m) => m.field?.receipts.some((r) => r.action_id === next.action_id)
      ? { ...m, field: { ...m.field!, receipts: m.field!.receipts.map((r) => (r.action_id === next.action_id ? { ...r, ...next } : r)) } }
      : m));
    refreshFieldViews();
  };
  /** The request's identity, taken the moment Send is pressed. */
  const fieldMeta = async (kind: "text" | "voice", base: { requestId: string; sentAt: string; clockVersion: number | null }): Promise<FieldMeta | null> => {
    const uid = actor.current;
    if (!uid || !conversation) return null;
    // A clock or unit-timer change still queued on this phone — or one that
    // cannot be checked — makes every timing action in this request wait.
    const pending = await phoneTimingPending(uid, {
      clockWrites: pendingClockWrites,
      workQueue: readWorkQueue,
      shiftId: queryClient.getQueryData<TimeShift | null>(["openShift", uid])?.id,
    });
    return { actor_id: uid, request_id: base.requestId, conversation_id: conversation, input_kind: kind, sent_at: base.sentAt, clock_version: base.clockVersion, clock_pending_sync: pending, audio_path: null, context: tagRef.current };
  };
  /** Before any upload, transcription or Ask call: is this still the screen and
   * the signed-in account the message was captured under? */
  const stillOwner = async (g: number, uid: string) => {
    if (!isCurrent(g) || actor.current !== uid) return false;
    const sameSession = await sessionUserIs(uid);
    return sameSession && isCurrent(g) && actor.current === uid;
  };
  const timingStateNow = useCallback(async (uid: string): Promise<PhoneTimingState> => {
    if (actor.current !== uid) return "unreadable";
    const state = await readPhoneTimingState(uid, { clockWrites: pendingClockWrites, workQueue: readWorkQueue, shiftId: queryClient.getQueryData<TimeShift | null>(["openShift", uid])?.id });
    return actor.current === uid ? state : "unreadable";
  }, []);
  const pressSend = () => ({ requestId: crypto.randomUUID(), sentAt: new Date().toISOString(), clockVersion: clockSeen.current });

  // Wave A4: Scheduling's "Plan with AI" button seeds this page with a
  // prompt naming the visible week — a PLACEHOLDER the owner edits before
  // sending, never auto-sent on arrival. Runs once per navigation (a fresh
  // `state` object each time React Router delivers one), so re-rendering
  // this page for any other reason never stomps on something typed since.
  useEffect(() => {
    if (!active) return;
    const state = location.state as { seed?: string; askContext?: unknown } | null;
    const seed = state?.seed;
    if (typeof seed === "string" && seed) setInput(seed);
    // K2.3: a job/unit screen hands over its tag the same way. Checked with the
    // server's own reader, so a malformed one is no tag rather than a bad id.
    const context = contextTagFromInput(state?.askContext);
    if (context) setTag(context);
  }, [location.state, active]);
  // A tag from a prior unit must not silently follow a worker across Work or
  // Schedule. New context can be supplied on the next visit to Ask.
  useEffect(() => { if (!active) setTag(null); }, [active]);

  // Freshen the bundled catalog whenever there is signal. The brain answers
  // fine without this ever succeeding.
  useEffect(() => {
    let cancelled = false;
    void refreshCatalogCache().then((types) => {
      if (!cancelled) setCatalog(types);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const index = useMemo(() => getBrainIndex(catalog), [catalog]);

  // --- Latest in view (lib/askLatest.ts) ---------------------------------------
  // The newest thing in the conversation — the person's own words or
  // transcript, the reply with its receipts, choice cards and clock buttons —
  // comes into view as it arrives, above the daily log card and the action
  // cards, which sit below the thread and used to leave it off screen. Someone
  // who scrolled up to read older messages, or who is typing a daily log
  // answer, keeps their place: the "New message" button offers it instead.
  const seen = useRef<{ newest: ChatMsg; count: number } | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const before = seen.current;
    const newest = messages[messages.length - 1];
    seen.current = { newest, count: messages.length };
    // Only a message ADDED at the end moves anything: not the first greeting,
    // a fresh screen, a receipt changing state in place, or older turns a
    // restore slots in ahead of what is already newest. A conversation that
    // comes back after a reload does count, and opens on its latest turn.
    if (!before || messages.length <= before.count || newest === before.newest) return;
    const rows = threadRef.current?.querySelectorAll("[data-msg]");
    if (!rows?.length) return;
    // Where the previously newest message is now, found by identity: a restore
    // puts older turns in front of it, so its old position means nothing.
    const at = messages.lastIndexOf(before.newest);
    const previous = spanOf(rows[at >= 0 ? at : before.count - 1]);
    const band = askBand();
    const box = latestTarget(threadRef.current, statusRef.current, answersMine(messages), band);
    if (!box) return;
    const delta = revealDelta(box, band);
    if (delta === 0) { setJump(null); return; }
    const typing = document.activeElement;
    if (readingHistory(previous, band) || (isTextEntry(typing) && typing !== inputRef.current)) {
      setJump(delta > 0 ? "down" : "up");
      return;
    }
    setJump(null);
    scrollPageBy(delta);
  }, [messages, active]);
  // The button goes once the new message is on screen, however it got there.
  useEffect(() => {
    if (!active || !jump) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const band = askBand();
        const box = latestTarget(threadRef.current, statusRef.current, false, band);
        if (box && inBand(box, band)) setJump(null);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); };
  }, [jump, active]);
  const jumpToLatest = () => {
    setJump(null);
    const band = askBand();
    const box = latestTarget(threadRef.current, statusRef.current, answersMine(messages), band);
    if (box) scrollPageBy(revealDelta(box, band));
  };

  // The label is shown translated; the query sent to send() stays the
  // original English phrase — the brain's keyword index (lib/brain,
  // lib/knowledge.ts) is English-only content, so a Spanish query would
  // simply fail to match. Translating the corpus itself is a separate,
  // much bigger effort than this UI sweep (see the S3b report).
  const suggestions = useMemo(
    () => [
      { label: t("field.suggestUnits"), query: t("field.suggestUnits") },
      { label: t("field.suggestNewJob"), query: t("field.suggestNewJob") },
      { label: t("ask.report.suggestHours"), query: t("ask.report.suggestHours") },
      { label: t("ask.report.suggestJob"), query: t("ask.report.suggestJob") },
      { label: t("ask.suggestion.singleHung"), query: "Single hung tips" },
      { label: t("ask.suggestion.flashing"), query: "What is flashing?" },
      { label: t("ask.suggestion.caulkBottom"), query: "Do I caulk the bottom?" },
      { label: t("ask.suggestion.drainSide"), query: "Which side does the drain face?" },
      { label: t("ask.suggestion.schedule"), query: "What's on our schedule?" },
      { label: t("ask.suggestion.nextUnit"), query: "My next unit" },
    ],
    [t],
  );

  /** `keepInput`: a card tap sends its own words and leaves whatever the
   * person typed in the box (K2.2). `operational`: an action card is always a
   * saved field request, whatever its words look like to the router.
   * Resolves to the reply shown, or null when nothing was sent or shown. */
  const send = (text: string, voiceMeta?: FieldMeta, sentFrom = gen.current, opts: { keepInput?: boolean; operational?: boolean; reportChannel?: "text" | "live" } = {}): Promise<ChatMsg | null> => {
    const q = text.trim();
    if (!q || busyRef.current || !isCurrent(sentFrom)) return Promise.resolve(null);
    busyRef.current = true;
    const g = gen.current;
    const uid = actor.current;
    // Send was pressed now; this is the time and clock view the request carries.
    // A daily-log message is a field request whatever its words look like:
    // the saved request row is the evidence the log entry will list (K2.7).
    const dailyLogMsg = logOpenRef.current || asksForDailyLog(q);
    const operationalNow = !!voiceMeta || opts.operational === true || dailyLogMsg || isOperationalAsk(q, messages.some(m => Boolean(m.artifacts?.length)) || fieldActive);
    const pressed = voiceMeta ? null : operationalNow && uid ? pressSend() : null;
    const requestId = voiceMeta?.request_id ?? pressed?.requestId;

    const history = messages
      .slice(1)
      // Exact reviewed lessons, especially an offline saved copy, are shown
      // verbatim and never become unstated context for a later model answer.
      .filter((m) => !m.cachedGuidance && !m.portalSources?.some((s) => s.kind === "hex-portal"))
      .map((m) => ({
        role: m.who === "me" ? ("user" as const) : ("assistant" as const),
        content: m.text + (m.artifacts?.length ? "\nReport filters/IDs for follow-up (re-query before answering): " + JSON.stringify(m.artifacts.map(a => a.kind === "time_report" ? { scope:a.scope,people:a.people,jobs:a.jobs } : { project:a.project })) : ""),
      }))
      .slice(-8);

    setMessages((m) => [...m, { who: "me", text: q, memoPath: voiceMeta?.audio_path ?? null, requestId }]);
    // A voice message sends itself when transcription finishes, and a card
    // sends its own words; whatever the person typed meanwhile is theirs and
    // stays in the box.
    if (!voiceMeta && !opts.keepInput) setInput("");
    setThinking(true);

    const online = typeof navigator === "undefined" ? true : navigator.onLine;

    const operationalQuestion = operationalNow;
    const learningContext=learningJob&&profile.data?.id&&!operationalQuestion?{actorId:profile.data.id,projectId:learningJob,unitLabel:learningUnit,question:q}:null;
    let portalNotice = learningContext ? (es ? "Esta respuesta todavía necesita revisión." : "This answer still needs review.") : "";
    const run = async (): Promise<ChatMsg> => {
      // Published guidance is returned verbatim. No model may reinterpret an
      // outdated revision, and an unavailable bridge never blocks normal Ask.
      if(learningContext&&online){
        try{
          const result=await findPortalGuidance(learningContext.projectId,q);
          if(result.items.length){
            if(profile.data?.role==="owner") await rememberVerifiedGuidance(learningContext.actorId,learningContext.projectId,q,result.items).catch(()=>undefined);
            portalNotice=es?"Guía revisada de Hexcore · revisiones exactas":"Reviewed Hexcore guidance · exact revisions";
            return {who:"infinity",text:result.items.map(d=>`${d.title} — revision ${d.revision}\n${d.answer}\n\n${d.applicability}\nEvidence: ${d.evidence}\nReview through: ${d.reviewBy}`).join("\n\n"),portalSources:result.items.map(d=>({id:d.id,title:d.title,kind:"hex-portal",revision:d.revision}))};
          }
          if(result.enabled) await forgetVerifiedGuidance(learningContext.actorId,learningContext.projectId,q).catch(()=>undefined);
          else clearPortalGuidanceCache();
          portalNotice=result.enabled?(es?"Todavía no hay una lección revisada que coincida. Respuesta normal de Ask.":"No matching reviewed lesson yet. Normal Ask answer."):(es?"Hex-Portal no está activado para este trabajo. Respuesta normal de Ask.":"Hex-Portal is not enabled for this job. Normal Ask answer.");
        }catch{ clearPortalGuidanceCache(); portalNotice=es?"No se pudo consultar Hexcore. Esta respuesta no usa lecciones revisadas.":"Could not check Hexcore. This answer does not use reviewed lessons."; }
      }
      if(learningContext&&!online&&profile.data?.role==="owner"){
        const saved=await readOfflineGuidance(learningContext.actorId,learningContext.projectId,q).catch(()=>null);
        if(saved){
          const checked=new Date(saved.checkedAt).toLocaleString(es?"es-US":"en-US");
          portalNotice=es?`Copia guardada de Hexcore, revisada por última vez ${checked}. Podría estar desactualizada; el acceso y los retiros no se pueden comprobar sin conexión.`:`Saved Hexcore copy, last checked ${checked}. It may be outdated; access and withdrawals cannot be checked offline.`;
          return {who:"infinity",text:saved.items.map(d=>`${d.title} — revision ${d.revision}\n${d.answer}\n\n${d.applicability}\nEvidence: ${d.evidence}\nReview through: ${d.reviewBy}`).join("\n\n"),cachedGuidance:true};
        }
      }
      // 1) Live job data the app already has cached — schedule, next window,
      //    my truck. No network needed and no model involved.
      const operational = operationalNow;
      const meta = voiceMeta ?? (pressed ? await fieldMeta("text", pressed) : null);
      // K2.7: while a daily-log draft is open, or when this message asks for
      // one, the request carries the draft — built from the AWAITED fresh
      // start(), never from a closed-over `logs.draft`, which is still null on
      // the very first message ("Build my daily log — I set six frames with
      // Ben") and would send the model no tool and lose those facts.
      const suggestedJob = tagRef.current ? { projectId: tagRef.current.project_id, label: tagLabel(tagRef.current) } : null;
      const daily = meta ? await dailyLogContextForMessage(logs, q, { cardOpen: logOpenRef.current, suggestedJob }) : { open: false, context: null };
      if (daily.open && isCurrent(g)) { logOpenRef.current = true; setLogOpen(true); }
      // A text message the server did not get is kept on this phone under its
      // speaker — and if the phone cannot keep it, it goes back in the box.
      const keepText = async (error: string): Promise<boolean> => {
        try {
          await keepUnsent({ userId: uid!, meta: meta!, text: q, audio: null, error });
          if (isCurrent(g)) setUnsent(await listUnsent(uid!).catch(() => []));
          return true;
        } catch {
          if (isCurrent(g)) setInput((current) => current || q);
          return false;
        }
      };
      // Field work is never answered from the cache or the brain, and a message
      // that cannot reach the server is kept, not guessed at.
      if (meta && !online) {
        const kept = meta.input_kind === "voice" || (await keepText("offline"));
        // Reports share the durable operational envelope, but still explain
        // why an offline total would be incomplete. Never show a cached total.
        const message = asksForReport(q)
          ? `${t("ask.report.offline")} ${t(kept ? "field.unsentTitle" : "field.notKept")}`
          : t(kept ? "field.needsConnection" : "field.notKept");
        return { who: "infinity", text: message };
      }
      const live = operational ? null : liveAnswer(q, gatherLiveData());
      if (live) {
        void logAskedQuestion(q, { kind: "answers", hits: [] }, { online });
        return { who: "infinity", text: live };
      }

      // 2) The company brain. This is the answer path — always available,
      //    always free, and incapable of making something up.
      const outcome = askBrain(index, q);
      void logAskedQuestion(q, outcome, { online });
      if (outcome.kind === "answers" && !operational) return brainMessage(outcome);

      // 3) Only when the brain has nothing written down, and only when the
      //    cloud AI is actually configured, offer what it can add. It is never
      //    a prerequisite for a correct answer and is skipped entirely with no
      //    key or offline. The server applies the company AI budget and role floor.
      let limitNote: string | undefined;
      if (shouldUseLLM({ online, supabaseConfigured })) {
        // The account may have changed while the phone read its queues: a
        // message is only ever sent as the person who said it.
        if (!isCurrent(g) || (meta && !(await stillOwner(g, meta.actor_id)))) {
          if (meta?.input_kind === "text") await keepText("other_account");
          return { who: "infinity", text: t("field.otherAccount") };
        }
        try {
          const { answer, sources, note, toolActivity, artifacts, field, buttons, navigation, dailyLog } = await askInfinity(q, history, meta ?? undefined, { contextTag: tagRef.current, dailyLog: daily.context });
          // The daily-log answers go into the draft only for this draft,
          // account and conversation, and only with the saved message behind
          // them; "missing_evidence" means the words were NOT recorded, and
          // the reply says so rather than showing them as captured.
          let draftApplied = false, dailyNotRecorded = false;
          if (dailyLog && isCurrent(g)) {
            const applied = applyDailyLogReply(logs, dailyLog);
            draftApplied = applied.applied;
            dailyNotRecorded = !applied.applied && applied.reason === "missing_evidence";
          }
          if (meta) {
            void dropUnsent(meta.request_id).then(async () => { if (isCurrent(g) && uid) setUnsent(await listUnsent(uid)); }).catch(() => undefined);
            if (isCurrent(g)) { clockSeen.current = null; readClockNow(g); }
            // The request now holds the recording: the in-memory copy can go.
            if (isCurrent(g) && field) setHeld((all) => all.filter((h) => h.meta.request_id !== meta.request_id));
            if (field?.receipts.length) refreshFieldViews();
          }
          if (answer || artifacts?.length || field?.receipts.length || field?.checklist || buttons?.length || navigation || dailyLog) return { who: "infinity", text: answer || note || "", sources, toolActivity, artifacts, field, buttons, navigation, draftApplied, dailyNotRecorded };
          limitNote = note;
        } catch {
          if (meta) {
            // The server may have saved some steps before failing; those show on
            // reload or when this message is sent again with the same id. A voice
            // message is already kept with its recording.
            const kept = meta.input_kind === "voice" || (await keepText("cloud"));
            return { who: "infinity", text: `${t("ask.report.cloudError")} ${t("field.stepFailed")}${kept ? "" : ` ${t("field.notKept")}`}` };
          }
          limitNote = t("ask.report.cloudError");
        }
      }
      if (operational) return { who: "infinity", text: limitNote || t(online ? "ask.report.cloudError" : "ask.report.offline") };
      return brainMessage(outcome, limitNote);
    };

    return run()
      .then((reply) => {
        if (!isCurrent(g)) return null;
        setMessages((m) => [...m, {...reply,reportChannel:opts.reportChannel,portalNotice,...learningContext&&!reply.artifacts?.length&&!reply.cachedGuidance?{learning:{...learningContext,answer:reply.text,sources:reply.portalSources??(reply.sources?.length?reply.sources.map(source=>({id:source.path.slice(0,160),title:source.title.slice(0,300),kind:"reference" as const})):(reply.hits??[]).map(hit=>({id:hit.entry.id.slice(0,160),title:hit.entry.title.slice(0,300),kind:"reference" as const})))}}:{}}]);
        return reply;
      })
      .catch(() => {
        if (isCurrent(g)) setMessages((m) => [...m, { who: "infinity", text: t("ask.somethingWentWrong"), reportChannel: opts.reportChannel }]);
        return null;
      })
      // A reply from before an account change or new setup must not end the
      // new screen's "thinking" state.
      .finally(() => { if (isCurrent(g)) { busyRef.current = false; setThinking(false); } });
  };
  // Live turns call the newest send(), not the one their session started with.
  const sendRef = useRef(send);
  sendRef.current = send;

  // --- Voice: the recording is evidence first, then words -------------------
  const lang = useLanguage().lang;
  /**
   * The recording is evidence first: kept on the phone (or held in memory,
   * with a visible warning, when the phone cannot keep it), then saved to the
   * speaker's private folder, then written out, then sent. Each step survives
   * the next one failing. Everything is tied to the account and setup it was
   * recorded under.
   */
  const voiceStep = async (blob: Blob, meta: FieldMeta, g: number, uid: string) => {
    if (!isCurrent(g)) return;
    setVoice("saving"); setVoiceError("");
    // Held in memory (download/retry card) until the phone keeps it or a sent
    // request holds it; uploaded bytes alone are not a recoverable record.
    setHeld((all) => [...all.filter((h) => h.meta.request_id !== meta.request_id), { blob, meta }]);
    const result = await runVoiceSteps({
      stillOwner: () => stillOwner(g, uid),
      keep: async (text, error) => {
        try {
          await keepUnsent({ userId: uid, meta, text, audio: blob, error });
          if (isCurrent(g)) { setHeld((all) => all.filter((h) => h.meta.request_id !== meta.request_id)); setUnsent(await listUnsent(uid).catch(() => [])); }
          return true;
        } catch {
          return false;
        }
      },
      upload: () => uploadMemo(uid, meta.request_id, blob),
      transcribe: () => {
        if (isCurrent(g)) setVoice("transcribing");
        const abort = new AbortController();
        recordAbort.current = abort;
        // K2.6: English, Spanish or a mix — the provider hears which; the
        // reply comes back in the language the person used.
        return transcribeDescription(blob, "auto", abort.signal);
      },
      send: (words, path) => { void send(words, { ...meta, audio_path: path }, g); },
    });
    if (!isCurrent(g)) return;
    setVoice("idle");
    if (result.outcome === "empty") setVoiceError(t("dictation.empty"));
    if (result.outcome === "failed") {
      if (!result.keptOnPhone) setVoiceError(t("field.recordingNotKept"));
      else setVoiceError(result.error === "offline" || !navigator.onLine ? t("field.needsConnection") : t("dictation.failed"));
    }
  };
  const startRecording = async () => {
    const uid = actor.current;
    if (voice !== "idle" || thinking || liveRef.current || !uid) return;
    const g = gen.current;
    setVoiceError(""); setSeconds(0);
    // A recording puts the action cards (and All actions) away for the
    // conversation (K2.2) — and the keyboard: iOS keeps a pinned bar on the
    // layout viewport, which runs on under an open keyboard, so the recorder
    // would sit behind it.
    setCardsHidden(true); setShowAll(false);
    const typing = document.activeElement;
    if (isTextEntry(typing)) typing.blur();
    readClockNow(g);
    recordAbort.current = new AbortController();
    // "starting" covers the microphone permission wait, which can sit on a
    // system dialog for as long as the person leaves it there.
    setVoice("starting");
    try {
      recording.current = await startVoiceRecording({
        signal: recordAbort.current.signal,
        onSeconds: (s) => { if (isCurrent(g)) setSeconds(s); },
        // Stopping the recording is pressing Send: that moment is the request time.
        onComplete: (blob) => {
          const pressed = pressSend();
          void fieldMeta("voice", pressed).then((meta) => { if (meta && isCurrent(g)) void voiceStep(blob, meta, g, uid); });
        },
        onError: (error) => { if (isCurrent(g)) { setVoice("idle"); setVoiceError(t(error.message === "empty_audio" ? "dictation.empty" : "dictation.failed")); } },
      });
      if (isCurrent(g)) setVoice("recording"); else recording.current?.cancel();
    } catch (e) {
      if (!isCurrent(g)) return;
      setVoice("idle");
      const code = e instanceof Error ? e.message : "";
      setVoiceError(t(code === "microphone_busy" ? "dictation.otherField" : code === "microphone_unsupported" ? "dictation.unsupported" : "dictation.permission"));
    }
  };
  const retryUnsent = async (item: UnsentField) => {
    const uid = actor.current;
    if (thinking || voice !== "idle" || liveRef.current || !uid || item.userId !== uid) return;
    const id = item.meta.request_id;
    if (retryingUnsent.current.has(id)) return;
    retryingUnsent.current.add(id);
    setRetryingIds(new Set(retryingUnsent.current));
    const g = gen.current;
    try {
      // Kept messages always belong to the account that recorded them.
      let meta: FieldMeta = { ...item.meta, actor_id: item.userId };
      if (item.error === "live_interrupted") {
        // The disconnected clip was only a draft. Its first Send now tap is
        // the request time, so use the clock and queue state from this moment.
        const clockVersion = await readClockVersion();
        const pending = await phoneTimingPending(uid, {
          clockWrites: pendingClockWrites,
          workQueue: readWorkQueue,
          shiftId: queryClient.getQueryData<TimeShift | null>(["openShift", uid])?.id,
        });
        if (!(await stillOwner(g, uid))) return;
        meta = { ...meta, sent_at: new Date().toISOString(), clock_version: clockVersion, clock_pending_sync: pending };
      }
      if (meta.input_kind === "voice" && item.audio && !item.text) { await voiceStep(item.audio, meta, g, uid); return; }
      if (!(await stillOwner(g, uid))) return;
      if (meta.input_kind === "voice" && item.audio) {
        try { meta = { ...meta, audio_path: await uploadMemo(uid, meta.request_id, item.audio) }; }
        catch { if (isCurrent(g)) setVoiceError(t("field.needsConnection")); return; }
      }
      if (await stillOwner(g, uid)) void send(item.text, meta, g);
    } finally {
      retryingUnsent.current.delete(id);
      if (isCurrent(g)) setRetryingIds(new Set(retryingUnsent.current));
    }
  };
  const discardUnsent = async (item: UnsentField) => {
    const g = gen.current, uid = actor.current;
    await dropUnsent(item.meta.request_id).catch(() => undefined);
    if (isCurrent(g) && uid) setUnsent(await listUnsent(uid).catch(() => []));
  };
  // --- Live Ask: the same evidence order as the recorder, per utterance -------
  /**
   * One finished utterance from a live conversation, in the recorder's order:
   * kept on the phone, the original saved to the speaker's private folder,
   * and only then transcribed through Forge's own dictation endpoint and sent
   * through send() as a VOICE request — which the database refuses without
   * that saved recording (ai_field_begin). GPT-Live emits partial transcript
   * deltas without a final-turn marker, so those are never used as an Ask
   * request. Everything else is runVoiceSteps unchanged,
   * including the ownership check before each outside call. Resolves to what
   * the voice may say, built from the receipts (liveAskCommentary).
   */
  const liveTurn = async (turn: LiveTurn, g: number, uid: string): Promise<string> => {
    let spokenText = "";
    const say = (outcome: LiveTurnOutcome) => {
      const answer = liveCommentary(spokenText, outcome);
      if (outcome.kind === "kept" && isCurrent(g)) setLiveIssue({ question: spokenText, answer });
      return answer;
    };
    // No recording, no request: the words alone are not evidence.
    if (!turn.audio) return say({ kind: "kept", keptOnPhone: false });
    const audio = turn.audio;
    setLiveSaving((n) => n + 1);
    try {
      // A worker may have changed the job clock on another Forge screen
      // during this same call. Bind this utterance to the current version.
      const clockVersion = await readClockVersion();
      const meta = await fieldMeta("voice", { requestId: crypto.randomUUID(), sentAt: new Date().toISOString(), clockVersion });
      if (!meta || meta.actor_id !== uid || !isCurrent(g)) return say({ kind: "other_account" });
      let reply: Promise<ChatMsg | null> = Promise.resolve(null);
      const result = await runVoiceSteps({
        stillOwner: () => stillOwner(g, uid),
        keep: async (text, error) => {
          try {
            await keepUnsent({ userId: uid, meta, text, audio, error });
            if (isCurrent(g)) setUnsent(await listUnsent(uid).catch(() => []));
            return true;
          } catch {
            // The phone cannot keep it: held in memory with the download card,
            // exactly like a recorder message the phone could not keep.
            if (isCurrent(g)) setHeld((all) => [...all.filter((h) => h.meta.request_id !== meta.request_id), { blob: audio, meta }]);
            return false;
          }
        },
        upload: () => uploadMemo(uid, meta.request_id, audio),
        transcribe: async () => { spokenText = await transcribeDescription(audio, "auto", new AbortController().signal); return spokenText; },
        send: (words, path) => { reply = sendRef.current(words, { ...meta, audio_path: path }, g, { reportChannel: "live" }); },
      });
      if (result.outcome === "not_owner") return say({ kind: "other_account" });
      if (result.outcome !== "sent") return say({ kind: "kept", keptOnPhone: result.keptOnPhone });
      const shown = await reply;
      // Not sent (another message was still going): it stays kept to send.
      if (!shown) return say({ kind: "kept", keptOnPhone: result.keptOnPhone });
      if (isCurrent(g) && shown.field) setHeld((all) => all.filter((h) => h.meta.request_id !== meta.request_id));
      if (isCurrent(g)) setLiveNavigation(shown.navigation ?? null);
      return say({ kind: "answered", reply: { text: shown.text, receipts: shown.field?.receipts, buttons: shown.buttons?.length, navigation: !!shown.navigation, artifacts: shown.artifacts?.length } });
    } finally {
      setLiveSaving((n) => Math.max(0, n - 1));
    }
  };
  const keepInterruptedAudio = (audioPromise: Promise<Blob | null>, g: number, uid: string, conversationId: string) => {
    // Keep the unsaved-work claim from the moment the recorder is stopped,
    // before Safari asynchronously delivers its final MP4 chunk.
    setLiveSaving((n) => n + 1);
    void (async () => {
      try {
        const audio = await audioPromise;
        if (!audio?.size) return;
        // This is an unfinished draft, never an automatic Ask request. The
        // conservative clock values are refreshed on its first Send now tap.
        const meta: FieldMeta = {
          actor_id: uid, request_id: crypto.randomUUID(), conversation_id: conversationId,
          input_kind: "voice", sent_at: new Date().toISOString(), clock_version: null,
          clock_pending_sync: true, audio_path: null, context: null,
        };
        try {
          await keepUnsent({ userId: uid, meta, text: "", audio, error: "live_interrupted" });
          if (isCurrent(g)) setUnsent(await listUnsent(uid).catch(() => []));
        } catch {
          // IndexedDB can fail on a full/private phone. Keep the audio in
          // memory with download controls rather than claiming it was saved.
          if (isCurrent(g)) setHeld((all) => [...all, { blob: audio, meta, interrupted: true }]);
        }
      } catch {
        // No final bytes arrived. Tell the person rather than claiming a memo
        // exists; the microphone has already closed.
        if (isCurrent(g)) setVoiceError(t("field.recordingNotKept"));
      } finally {
        setLiveSaving((n) => Math.max(0, n - 1));
      }
    })();
  };
  const startLive = () => {
    const uid = actor.current;
    if (!livePilot || !uid || !conversation || liveRef.current || liveSaving > 0 || voice !== "idle" || busyRef.current) return;
    const g = gen.current;
    // Like the recorder: the cards and the keyboard go away.
    setCardsHidden(true); setShowAll(false);
    const typing = document.activeElement;
    if (isTextEntry(typing)) typing.blur();
    readClockNow(g);
    setLiveMuted(false); setLiveExpiring(false); setLiveNavigation(null);
    setLive({ status: "starting" });
    const session: LiveSession = startLiveSession({
      onStatus: (status, detail) => {
        if (liveRef.current !== session) return;
        if (status === "ended" || status === "failed") { liveRef.current = null; setLiveMuted(false); setLiveExpiring(false); }
        setLive({ status, detail });
      },
      handleTurn: (turn) => liveTurn(turn, g, uid),
      onInterruptedAudio: (audio) => keepInterruptedAudio(audio, g, uid, conversation),
      notHeard: () => liveCommentary("", { kind: "not_heard" }),
      onTimeLimitSoon: () => setLiveExpiring(true),
    });
    liveRef.current = session;
  };
  restartLiveRef.current = startLive;
  // Only a real shell unmount ends the conversation. Route changes keep this
  // component mounted so the same microphone and paid session survive.
  useEffect(() => () => liveRef.current?.end("unmount"), []);
  const heldUrls = useMemo(() => held.map((h) => URL.createObjectURL(h.blob)), [held]);
  useEffect(() => () => { heldUrls.forEach((url) => URL.revokeObjectURL(url)); }, [heldUrls]);
  const startNewSetup = () => {
    const uid = actor.current;
    if (!uid || thinking || voice !== "idle" || liveRef.current) return;
    resetFieldUi(uid);
    setConversation(startNewConversation(uid));
    readClockNow();
  };

  // --- Context tag -----------------------------------------------------------
  /** "BLACK22 · Black Desert · Unit 4": the job's own words when the screen
   * that opened Ask sent none, from the jobs list already cached here. */
  const tagLabel = (x: AskContextTag): string => {
    const cached = queryClient.getQueryData<Project[]>(["projects"])?.find((p) => p.id === x.project_id);
    const job = x.project_label ?? (cached ? [cached.job_code, cached.name].filter(Boolean).join(" · ") : t("field.tag.job"));
    return x.unit_label ? `${job} · ${t("field.tag.unit", { unit: x.unit_label })}` : job;
  };

  // --- Action cards ----------------------------------------------------------
  // K2.2: the cards go the moment the composer has text, a recording starts or
  // a card is tapped, and "Actions" brings them back. The owner, 2026-09-24:
  // "Every time I click the microphone, a lot of other options open up when I
  // previously minimized them" — they used to spring back whenever the box was
  // empty again, so every send and every finished recording reopened them.
  // Put away now means put away: a send, a reply, a recording ending or the
  // box emptying never reopen them; only the Actions tap does. Hide and
  // Actions are the person's own choice, remembered on this phone for them.
  const typed = input.trim() !== "";
  // It is STARTING to type that puts them away (a seeded prompt counts), not
  // the box having words: once Actions brings them back over typed words they
  // stay until the next time the box goes from empty to typed.
  useEffect(() => { if (typed) { setCardsHidden(true); setShowAll(false); } }, [typed]);
  const hideCards = () => {
    setCardsHidden(true);
    if (actor.current) rememberCardsHidden(actor.current, true);
  };
  const showCards = () => {
    setCardsHidden(false);
    if (actor.current) rememberCardsHidden(actor.current, false);
  };
  const pickCard = (pick: CardPick) => {
    setShowAll(false);
    setCardsHidden(true);
    void send(pick.query, undefined, gen.current, { keepInput: true, operational: pick.operational });
  };
  // One button, rendered where it can be seen: in the pinned recorder while
  // that is up, otherwise in its own row just above the tab bar.
  const jumpButton = jump ? (
    <button type="button" className="ask-jump" onClick={jumpToLatest}>
      {t("field.newMessage")}
      {jump === "up" ? <ArrowUp size={18} aria-hidden="true" /> : <ArrowDown size={18} aria-hidden="true" />}
    </button>
  ) : null;

  return (
    <div className="page ask-page">
      <header className="page-header">
        <div>
          <p className="home-greeting ai-eyebrow">
            <Sparkles size={13} /> Forge
          </p>
          <h1>{t("ask.title")}</h1>
        </div>
        <BackChip label={t("ask.back")} />
      </header>

      {userId && <LearningPanel key={userId} projectId={learningJob} unitLabel={learningUnit} actorId={userId} onProject={setLearningJob} onUnit={setLearningUnit}/>}
      <div className="ask-thread" ref={threadRef}>
        {messages.map((m, i) => (
          <div key={i} data-msg={i} className={m.who === "me" ? "ask-msg mine" : "ask-msg"}>
            {/* Wave A4: plain progress lines while the model worked (tool
                calls already finished by the time this renders — the
                request isn't streamed — but the trace still reads as "here's
                what it did" ahead of the summary). */}
            {m.toolActivity && m.toolActivity.length > 0 && (
              <div className="ask-progress muted" aria-live="polite">
                {m.toolActivity.map((line, idx) => (
                  <div key={idx}>{line}</div>
                ))}
              </div>
            )}
            <div
              className={m.who === "me" ? "ask-bubble mine" : "ask-bubble"}
              style={{ whiteSpace: "pre-line" }}
            >
              {m.who === "me" ? m.text : cleanAskText(m.text)}
            </div>
            {m.memoPath && <MemoPlayback path={m.memoPath} />}
            {m.field?.receipts.map((r) => <FieldReceiptCard key={`${userId}:${r.action_id}`} receipt={r} draft={m.field?.draft} actorId={userId} onChange={updateReceipt} timingState={timingStateNow} />)}
            {m.field?.checklist && m.field.checklist === latestChecklist && !setupSaved && <FieldChecklist key={m.field.request_id} checklist={m.field.checklist} />}
            {m.buttons && m.buttons.length > 0 && <ClockButtons buttons={m.buttons} />}
            {m.navigation && <NavigationButton action={m.navigation} />}
            {m.dailyNotRecorded && <p role="alert" className="cw-error">{t("field.dailyNotRecorded")}</p>}
            {/* K2.5: words that read as done with nothing behind them are
                contradicted here, automatically. */}
            {m.who === "infinity" && needsNothingSavedNotice({ text: m.text, receipts: m.field?.receipts, artifacts: m.artifacts, draftApplied: m.draftApplied || !!m.field?.learning }) && (
              <p className="field-nothing-saved" role="status"><strong>{t("field.nothingSaved")}</strong> · {t("field.nothingSavedHelp")}</p>
            )}
            {m.portalNotice&&<p className="ask-sources muted">{m.portalNotice}</p>}
            {m.learning&&<LearningCard draft={m.learning}/>}
            {m.artifacts?.map(artifact => <ReportCard key={artifact.id} artifact={artifact}/>)}
            {m.hits && m.hits.length > 0 && (
              <p className="ask-sources muted">{t("ask.from", { source: m.hits[0].entry.source })}</p>
            )}
            {m.hits && m.hits.length > 1 && (
              <div className="ask-alternates">
                <p className="muted" style={{ margin: "4px 0 2px", fontSize: 12 }}>
                  {t("ask.alsoWrittenDown")}
                </p>
                {m.hits.slice(1).map((hit) => (
                  <details key={hit.entry.id} className="ask-alternate">
                    <summary>
                      {hit.entry.title}
                      <span className="muted"> · {hit.entry.source}</span>
                    </summary>
                    <div style={{ whiteSpace: "pre-line" }}>{hit.entry.body}</div>
                  </details>
                ))}
              </div>
            )}
            {m.sources && m.sources.length > 0 && (
              <p className="ask-sources muted">
                {t("ask.sources", { list: m.sources.map((s) => s.title).join(", ") })}
              </p>
            )}
            {userId && m.who === "infinity" && messages.slice(0, i).some((before) => before.who === "me") &&
              <AiIssueReport key={`${userId}:${i}`} actorId={userId} channel={m.reportChannel ?? "text"}
                question={messages.slice(0, i).reverse().find((before) => before.who === "me")?.text ?? ""} answer={m.text} />}
          </div>
        ))}
        {learningPrep && userId && (
          <LearningReviewForm key={`${userId}:${learningPrep.request_id}`} keepKey={learningPrep.request_id} actorId={userId}
            projectId={learningPrep.project_id} via="ask" initial={learningPrep.content} initialReviewer={learningPrep.reviewer}
            requestId={learningPrep.request_id} sourceRequestIds={learningPrep.source_request_ids ?? [learningPrep.request_id]} unitId={learningPrep.unit_id}
            source={{ newCase: { actorId: userId, projectId: learningPrep.project_id, unitLabel: learningPrep.unit_label ?? "",
              question: (learningWords || learningPrep.content.what_happened || learningPrep.content.issue || "Lesson write-up").slice(0, 8000),
              answer: (learningReply?.text ?? "").slice(0, 20000), sources: [] } }} />
        )}
        <div ref={statusRef} role="status" aria-live="polite" className={thinking ? "ask-bubble" : undefined}>
          {thinking ? (es ? "Buscando una respuesta…" : "Finding an answer…") : ""}
        </div>
      </div>

      {restoreError && <p className="muted" role="status">{t("field.restoreFailed")}</p>}
      {unsent.length > 0 && (
        <section className="field-card field-unsent" aria-label={t("field.unsentTitle")}>
          <h3>{t("field.unsentTitle")}</h3>
          <p className="muted">{t("field.unsentHelp")}</p>
          {unsent.map((u) => (
            <div key={u.meta.request_id} className="field-unsent-row">
              <span>{u.text || (u.error === "live_interrupted" ? liveText(es, "interruptedMemo") : t("field.memo"))} · {new Date(u.meta.sent_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              {u.error === "live_interrupted" && u.audio && <LocalMemoPlayback audio={u.audio} label={liveText(es, "listenMemo")} />}
              <button type="button" disabled={thinking || voice !== "idle" || liveOn || retryingIds.has(u.meta.request_id)} onClick={() => void retryUnsent(u)}>{t("field.sendNow")}</button>
              <button type="button" disabled={retryingIds.has(u.meta.request_id)} onClick={() => void discardUnsent(u)}>{t("field.discard")}</button>
            </div>
          ))}
        </section>
      )}
      {voiceError && <p role="alert" className="cw-error">{voiceError}</p>}
      {userId && (voiceError || liveIssue || live.status === "failed") && <AiIssueReport
        key={`${userId}:${liveIssue?.answer ?? voiceError ?? live.detail}`} actorId={userId}
        channel={liveIssue || live.status === "failed" ? "live" : "text"}
        question={liveIssue?.question ?? ""} answer={liveIssue?.answer ?? voiceError ?? liveStatusLine(es, live.status, live.detail)} />}
      {held.length > 0 && userId && (
        <section className="field-card field-unsent" role="alert">
          <p>{t("field.recordingNotKept")}</p>
          {held.map((h, index) => (
            <div key={h.meta.request_id} className="field-unsent-row">
              <LocalMemoPlayback audio={h.blob} label={liveText(es, "listenMemo")} />
              <button type="button" disabled={voice !== "idle" || liveOn || retryingIds.has(h.meta.request_id)} onClick={() => void (h.interrupted
                ? retryUnsent({ userId, meta: h.meta, text: "", audio: h.blob, error: "live_interrupted" })
                : voiceStep(h.blob, h.meta, gen.current, userId))}>{t("field.sendNow")}</button>
              <a className="chip" href={heldUrls[index]} download={`forge-recording-${h.meta.sent_at.slice(0, 19).replace(/[:T]/g, "-")}.${h.blob.type.includes("mp4") ? "m4a" : "webm"}`}>{t("field.downloadRecording")}</a>
            </div>
          ))}
        </section>
      )}
      {logOpen && userId && (
        <>
          <AiDailyLogCard controller={logs} onAnswerByVoice={() => void startRecording()} />
          <button type="button" className="chip" onClick={() => { setLogOpen(false); logOpenRef.current = false; }}>{t("field.dailyHide")}</button>
        </>
      )}
      {tag && (
        <div className="ask-tag" role="status">
          <span className="muted">{t("field.tag.title")}</span> <strong>{tagLabel(tag)}</strong>
          <button type="button" className="chip" aria-label={t("field.tag.clear")} onClick={() => setTag(null)}>×</button>
        </div>
      )}
      {/* Action cards (K2.2): four per role + All actions. Put away by typing,
          a recording, a card tap or Hide; back ONLY with Actions — one button
          that stays where it is either way. Tapping a card sends the card's
          own words and never touches what was typed. */}
      {showAll ? (
        <div className="ask-actions">
          {fieldActive && userId && (
            <button type="button" className="ask-new-setup" disabled={thinking || voice !== "idle" || liveOn} onClick={startNewSetup}>{t("field.newSetup")}</button>
          )}
          <AllActions rank={cardRank} lang={lang} running={running} questions={suggestions} onClose={() => setShowAll(false)} onPick={pickCard} />
        </div>
      ) : (
        <div className="ask-actions">
          <div className="ask-actions-head">
            <button type="button" className="ask-actions-toggle" aria-expanded={!cardsHidden} onClick={cardsHidden ? showCards : hideCards}>
              {cardsHidden ? <ChevronDown size={18} aria-hidden="true" /> : <ChevronUp size={18} aria-hidden="true" />}
              {t(cardsHidden ? "field.cards.reopen" : "field.cards.hide")}
            </button>
            {fieldActive && userId && (
              <button type="button" className="ask-new-setup" disabled={thinking || voice !== "idle" || liveOn} onClick={startNewSetup}>{t("field.newSetup")}</button>
            )}
          </div>
          {!cardsHidden && <ActionCards rank={cardRank} lang={lang} running={running} onPick={pickCard} onAll={() => setShowAll(true)} />}
        </div>
      )}

      {/* "New message": a zero-height row that sticks just above the tab bar
          while the composer is in its place at the end of the page. */}
      {jumpButton && !pinned && <div className="ask-jump-row">{jumpButton}</div>}

      {/* On phones the composer stays in a solid bottom dock above navigation;
          the conversation scrolls with a reading gap above it. Desktop keeps
          the in-flow composer and pins it while recording. */}
      <div ref={dockRef} className={pinned ? "ask-dock is-pinned" : "ask-dock"}>
        {pinned && jumpButton}
        {livePilot && userId && live.status !== "idle" && (
          <p className="ask-dock-status" role="status" aria-live="polite">
            {liveOn && live.status !== "starting" && <span className="ask-rec-dot" aria-hidden="true" />}
            {liveExpiring && liveOn ? liveText(es, "endingSoon") : liveStatusLine(es, live.status, live.detail)}
            {liveSaving > 0 && ` · ${liveText(es, "saving")}`}
          </p>
        )}
        {voice !== "idle" && (
          <p className="ask-dock-status" role="status" aria-live="polite">
            {voice === "recording" && <span className="ask-rec-dot" aria-hidden="true" />}
            {t(voice === "starting" ? "field.micStarting" : voice === "recording" ? "field.recordingNow" : voice === "saving" ? "field.savingMemo" : "field.transcribing")}
          </p>
        )}
        <div className="ask-input">
          <input
            ref={inputRef}
            aria-label={t("ask.inputPlaceholder")}
            placeholder={t("ask.inputPlaceholder")}
            value={input}
            onChange={(e) => {
              // Starting a message is when the phone notes the clock it is looking at.
              if (!input && e.target.value) readClockNow();
              setInput(e.target.value);
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && !liveOn) void send(input); }}
          />
          {userId && (voice === "recording" ? (
            <button type="button" className="ask-send ask-mic recording" onClick={() => recording.current?.stop()} aria-label={t("field.stopRecording", { seconds })}>
              <Square size={16} /> <span className="ask-mic-seconds">{seconds}s</span>
            </button>
          ) : (
            <button type="button" className="ask-send ask-mic" disabled={thinking || voice !== "idle" || liveOn} onClick={() => void startRecording()} aria-label={t("field.record")}>
              <Mic size={18} />
            </button>
          ))}
          <button type="button" className="ask-send" disabled={thinking || !input.trim() || liveOn} onClick={() => void send(input)} aria-label={t("ask.send")}>
              <ArrowUp size={21} strokeWidth={2.7} aria-hidden="true" />
          </button>
        </div>
        {/* Live Ask (pilot): an explicit Start and End, never always-on. */}
        {livePilot && userId && (
          <div className="ask-live">
            {liveOn ? (
              <button type="button" className="ask-live-button recording" onClick={() => liveRef.current?.end("user")} aria-label={liveText(es, "end")}>
                <Square size={14} aria-hidden="true" /> {liveText(es, "end")}
              </button>
            ) : (
              <button type="button" className="ask-live-button" disabled={thinking || voice !== "idle" || liveSaving > 0} onClick={startLive} aria-label={liveText(es, canContinueLive(live.status, live.detail) ? "continue" : "start")}>
                <Radio size={15} aria-hidden="true" /> {liveText(es, canContinueLive(live.status, live.detail) ? "continueButton" : "startButton")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
