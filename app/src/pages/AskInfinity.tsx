import {useQuery} from "@tanstack/react-query";
import {getRealProfile} from "../lib/install/api";
import {LearningPanel} from "../components/hexPortal/LearningPanel";
import {LearningCard} from "../components/hexPortal/LearningCard";
import {LearningReviewForm} from "../components/hexPortal/LearningReviewForm";
import {findPortalGuidance,type PortalSource,type LearningDraft} from "../lib/hexPortal";
import "../components/hexPortal/hexPortal.css";
import type { AskArtifact } from "../../../supabase/functions/_shared/askReporting.ts";
import { ReportCard } from "../components/ask/ReportCard";
import { asksForReport, isOperationalAsk } from "../lib/askRouting";
import { cleanAskText } from "../lib/cleanAskText";
import { BackChip } from "../components/BackChip";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  readClockVersion, runVoiceSteps, sessionUserIs, startNewConversation, uploadMemo, type FieldMeta, type FieldReceipt, type FieldReply, type UnsentField,
} from "../lib/fieldAsk";
import { pendingClockWrites } from "../lib/offline/outbox";
import { readWorkQueue } from "../lib/customWork/queue";
import { startVoiceRecording, type VoiceRecording } from "../lib/voiceRecording";
import { transcribeDescription } from "../lib/dictation";
import { useUnsavedWorkWhile } from "../lib/pwa/useUnsavedWork";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Mic, Square } from "lucide-react";
import { inBand, isTextEntry, readingHistory, revealDelta, scrollPageBy, spanOf, unionSpan, visibleBand, type Span } from "../lib/askLatest";
import { readCardsHidden, rememberCardsHidden } from "../lib/askCardsPref";
import type { TimeShift } from "../lib/timeclock";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { roleRank } from "../lib/install/types";
import { listWorkSessions, listWorkUnits } from "../lib/customWork/api";
import { ActionCards, AllActions, type CardPick, type RunningUnit } from "../components/ask/ActionCards";
import { contextTagFromInput, type AskContextTag } from "../../../supabase/functions/_shared/fieldTools";
import { readClockButtons, type ClockButton } from "../../../supabase/functions/_shared/clockButtons";
import { ClockButtons } from "../components/ask/ClockButtons";
import { needsNothingSavedNotice } from "../lib/askReceiptGuard";
import { AiDailyLogCard } from "../components/aiDailyLogs/AiDailyLogCard";
import { useAiDailyLogDraft } from "../lib/aiDailyLogs/useAiDailyLogDraft";
import { applyDailyLogReply, asksForDailyLog, dailyLogContextForMessage } from "../lib/aiDailyLogs/askBridge";
import { signedInEmail } from "../lib/signedIn";

// Every cached screen a field receipt may have changed (see FIELD_QUERY_ROOTS).
const refreshFieldViews = () => { for (const root of FIELD_QUERY_ROOTS) void queryClient.invalidateQueries({ queryKey: [root] }); };

interface ChatMsg {
  /** Field work: database receipts and the checklist, never model claims. */
  field?: FieldReply;
  /** One-tap job-clock buttons the reply offered (K2.4): the tap is the change. */
  buttons?: ClockButton[];
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

/** Where the newest message is on screen — with "Finding an answer…" under it
 * while that shows, so a sent message and its wait come into view together. */
function newestSpan(thread: HTMLElement | null, status: HTMLElement | null): Span | null {
  const rows = thread ? thread.querySelectorAll("[data-msg]") : null;
  return unionSpan([rows && rows.length ? spanOf(rows[rows.length - 1]) : null, spanOf(status)]);
}

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

export function AskInfinity() {
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
  const [voice, setVoice] = useState<"idle" | "starting" | "recording" | "saving" | "transcribing">("idle");
  /** While the microphone is on — asking, recording, saving, writing it out —
   * the composer is the recorder and is pinned to the bottom of the screen
   * (see the dock below). Read through a ref by effects that measure it. */
  const pinned = voice !== "idle";
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const [seconds, setSeconds] = useState(0);
  const [voiceError, setVoiceError] = useState("");
  const [restoreError, setRestoreError] = useState(false);
  const recording = useRef<VoiceRecording | null>(null);
  const recordAbort = useRef<AbortController | null>(null);
  /** A recording the phone could not keep yet: held in memory until it is
   * saved on the phone or on the server, never silently dropped. */
  const [held, setHeld] = useState<{ blob: Blob; meta: FieldMeta } | null>(null);
  // From asking for the microphone until the recording is kept on the phone
  // or held by a sent request, the only copy is in this component's memory —
  // and a held recording is, by definition, one the phone could NOT keep. An
  // automatic app update must not reload over any of it (independent review,
  // 2026-09-23). Released by durability or by the person, never by the mic
  // merely stopping.
  useUnsavedWorkWhile(voice !== "idle" || held !== null);
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
    recordAbort.current?.abort();
    recording.current?.cancel();
    recording.current = null;
    clockSeen.current = null;
    if (!keepInput) setInput("");
    setVoice("idle"); setThinking(false); setVoiceError(""); setRestoreError(false); setHeld(null);
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
            restored.push({ who: "infinity", text: turn.reply?.answer ?? "", toolActivity: turn.reply?.toolActivity, buttons: readClockButtons(turn.reply?.buttons),
              artifacts: (turn.reply?.artifacts ?? []).filter((a) => a && ["time_report", "job_summary"].includes(a.kind)).slice(0, 4),
              sources: turn.reply?.sources ?? [],
              field: { request_id: turn.id, receipts: turn.receipts, checklist: turn.captured?.checklist ?? null, learning: turn.captured?.learning ?? null } });
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
  const latestChecklist = [...messages].reverse().find((m) => m.field?.checklist)?.field?.checklist ?? null;
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
  const timingPendingNow = () => {
    const uid = actor.current;
    if (!uid) return Promise.resolve(true);
    return phoneTimingPending(uid, { clockWrites: pendingClockWrites, workQueue: readWorkQueue, shiftId: queryClient.getQueryData<TimeShift | null>(["openShift", uid])?.id });
  };
  const pressSend = () => ({ requestId: crypto.randomUUID(), sentAt: new Date().toISOString(), clockVersion: clockSeen.current });

  // Wave A4: Scheduling's "Plan with AI" button seeds this page with a
  // prompt naming the visible week — a PLACEHOLDER the owner edits before
  // sending, never auto-sent on arrival. Runs once per navigation (a fresh
  // `state` object each time React Router delivers one), so re-rendering
  // this page for any other reason never stomps on something typed since.
  useEffect(() => {
    const state = location.state as { seed?: string; askContext?: unknown } | null;
    const seed = state?.seed;
    if (typeof seed === "string" && seed) setInput(seed);
    // K2.3: a job/unit screen hands over its tag the same way. Checked with the
    // server's own reader, so a malformed one is no tag rather than a bad id.
    const context = contextTagFromInput(state?.askContext);
    if (context) setTag(context);
  }, [location.state]);

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
    const box = newestSpan(threadRef.current, statusRef.current);
    if (!box) return;
    const band = visibleBand(pinnedRef.current ? dockRef.current : null);
    const delta = revealDelta(box, band);
    if (delta === 0) { setJump(null); return; }
    const typing = document.activeElement;
    if (readingHistory(previous, band) || (isTextEntry(typing) && typing !== inputRef.current)) {
      setJump(delta > 0 ? "down" : "up");
      return;
    }
    setJump(null);
    scrollPageBy(delta);
  }, [messages]);
  // The button goes once the new message is on screen, however it got there.
  useEffect(() => {
    if (!jump) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = newestSpan(threadRef.current, statusRef.current);
        if (box && inBand(box, visibleBand(pinnedRef.current ? dockRef.current : null))) setJump(null);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); };
  }, [jump]);
  const jumpToLatest = () => {
    setJump(null);
    const box = newestSpan(threadRef.current, statusRef.current);
    if (box) scrollPageBy(revealDelta(box, visibleBand(pinnedRef.current ? dockRef.current : null)));
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
   * saved field request, whatever its words look like to the router. */
  const send = (text: string, voiceMeta?: FieldMeta, sentFrom = gen.current, opts: { keepInput?: boolean; operational?: boolean } = {}) => {
    const q = text.trim();
    if (!q || thinking || !isCurrent(sentFrom)) return;
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
          if(result.items.length){portalNotice=es?"Guía revisada de Hexcore · revisiones exactas":"Reviewed Hexcore guidance · exact revisions";return {who:"infinity",text:result.items.map(d=>`${d.title} — revision ${d.revision}\n${d.answer}\n\n${d.applicability}\nEvidence: ${d.evidence}\nReview through: ${d.reviewBy}`).join("\n\n"),portalSources:result.items.map(d=>({id:d.id,title:d.title,kind:"hex-portal",revision:d.revision}))};}
          portalNotice=result.enabled?(es?"Todavía no hay una lección revisada que coincida. Respuesta normal de Ask.":"No matching reviewed lesson yet. Normal Ask answer."):(es?"Hex-Portal no está activado para este trabajo. Respuesta normal de Ask.":"Hex-Portal is not enabled for this job. Normal Ask answer.");
        }catch{ portalNotice=es?"No se pudo consultar Hexcore. Esta respuesta no usa lecciones revisadas.":"Could not check Hexcore. This answer does not use reviewed lessons."; }
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
          const { answer, sources, note, toolActivity, artifacts, field, buttons, dailyLog } = await askInfinity(q, history, meta ?? undefined, { contextTag: tagRef.current, dailyLog: daily.context });
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
            if (isCurrent(g) && field) setHeld((h) => (h?.meta.request_id === meta.request_id ? null : h));
            if (field?.receipts.length) refreshFieldViews();
          }
          if (answer || artifacts?.length || field?.receipts.length || field?.checklist || buttons?.length || dailyLog) return { who: "infinity", text: answer || note || "", sources, toolActivity, artifacts, field, buttons, draftApplied, dailyNotRecorded };
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

    void run()
      .then((reply) => isCurrent(g) && setMessages((m) => [...m, {...reply,portalNotice,...learningContext&&!reply.artifacts?.length?{learning:{...learningContext,answer:reply.text,sources:reply.portalSources??(reply.sources?.length?reply.sources.map(source=>({id:source.path.slice(0,160),title:source.title.slice(0,300),kind:"reference" as const})):(reply.hits??[]).map(hit=>({id:hit.entry.id.slice(0,160),title:hit.entry.title.slice(0,300),kind:"reference" as const})))}}:{}}]))
      .catch(() => {
        if (isCurrent(g)) setMessages((m) => [...m, { who: "infinity", text: t("ask.somethingWentWrong") }]);
      })
      // A reply from before an account change or new setup must not end the
      // new screen's "thinking" state.
      .finally(() => { if (isCurrent(g)) setThinking(false); });
  };

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
    setHeld({ blob, meta });
    const result = await runVoiceSteps({
      stillOwner: () => stillOwner(g, uid),
      keep: async (text, error) => {
        try {
          await keepUnsent({ userId: uid, meta, text, audio: blob, error });
          if (isCurrent(g)) { setHeld(null); setUnsent(await listUnsent(uid).catch(() => [])); }
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
      send: (words, path) => send(words, { ...meta, audio_path: path }, g),
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
    if (voice !== "idle" || thinking || !uid) return;
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
    if (thinking || voice !== "idle" || !uid || item.userId !== uid) return;
    const g = gen.current;
    // Kept messages always belong to the account that recorded them.
    let meta: FieldMeta = { ...item.meta, actor_id: item.userId };
    if (meta.input_kind === "voice" && item.audio && !item.text) { await voiceStep(item.audio, meta, g, uid); return; }
    if (!(await stillOwner(g, uid))) return;
    if (meta.input_kind === "voice" && item.audio) {
      try { meta = { ...meta, audio_path: await uploadMemo(uid, meta.request_id, item.audio) }; }
      catch { if (isCurrent(g)) setVoiceError(t("field.needsConnection")); return; }
    }
    if (await stillOwner(g, uid)) send(item.text, meta, g);
  };
  const discardUnsent = async (item: UnsentField) => {
    const g = gen.current, uid = actor.current;
    await dropUnsent(item.meta.request_id).catch(() => undefined);
    if (isCurrent(g) && uid) setUnsent(await listUnsent(uid).catch(() => []));
  };
  const heldUrl = useMemo(() => (held ? URL.createObjectURL(held.blob) : null), [held]);
  useEffect(() => () => { if (heldUrl) URL.revokeObjectURL(heldUrl); }, [heldUrl]);
  const startNewSetup = () => {
    const uid = actor.current;
    if (!uid || thinking || voice !== "idle") return;
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
    send(pick.query, undefined, gen.current, { keepInput: true, operational: pick.operational });
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
            {m.field?.receipts.map((r) => <FieldReceiptCard key={r.action_id} receipt={r} onChange={updateReceipt} timingPending={timingPendingNow} />)}
            {m.field?.checklist && m.field.checklist === latestChecklist && <FieldChecklist checklist={m.field.checklist} />}
            {m.buttons && m.buttons.length > 0 && <ClockButtons buttons={m.buttons} />}
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
              <span>{u.text || t("field.memo")} · {new Date(u.meta.sent_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              <button type="button" disabled={thinking || voice !== "idle"} onClick={() => void retryUnsent(u)}>{t("field.sendNow")}</button>
              <button type="button" onClick={() => void discardUnsent(u)}>{t("field.discard")}</button>
            </div>
          ))}
        </section>
      )}
      {fieldActive && userId && (
        <button type="button" className="chip" disabled={thinking || voice !== "idle"} onClick={startNewSetup}>
          {t("field.newSetup")}
        </button>
      )}
      {voiceError && <p role="alert" className="cw-error">{voiceError}</p>}
      {held && userId && (
        <section className="field-card field-unsent" role="alert">
          <p>{t("field.recordingNotKept")}</p>
          <div className="field-unsent-row">
            <button type="button" disabled={voice !== "idle"} onClick={() => void voiceStep(held.blob, held.meta, gen.current, userId)}>{t("field.sendNow")}</button>
            <a className="chip" href={heldUrl ?? undefined} download={`forge-recording-${held.meta.sent_at.slice(0, 19).replace(/[:T]/g, "-")}.${held.blob.type.includes("mp4") ? "m4a" : "webm"}`}>{t("field.downloadRecording")}</a>
          </div>
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
        <AllActions rank={cardRank} lang={lang} running={running} questions={suggestions} onClose={() => setShowAll(false)} onPick={pickCard} />
      ) : (
        <div className="ask-actions">
          <button type="button" className="ask-actions-toggle" aria-expanded={!cardsHidden} onClick={cardsHidden ? showCards : hideCards}>
            {cardsHidden ? <ChevronDown size={18} aria-hidden="true" /> : <ChevronUp size={18} aria-hidden="true" />}
            {t(cardsHidden ? "field.cards.reopen" : "field.cards.hide")}
          </button>
          {!cardsHidden && <ActionCards rank={cardRank} lang={lang} running={running} onPick={pickCard} onAll={() => setShowAll(true)} />}
        </div>
      )}

      {/* "New message": a zero-height row that sticks just above the tab bar
          while the composer is in its place at the end of the page. */}
      {jumpButton && !pinned && <div className="ask-jump-row">{jumpButton}</div>}

      {/* The composer. While the microphone is on it is the recorder, pinned
          to the bottom of the screen over whatever is scrolled — the owner,
          2026-09-24: "the chat bar that shows that it's recording should
          follow me … I had to scroll to the bottom and not know that the
          microphone was working." Only then: a sticky bar and an open iOS
          keyboard fight (the bar stays on the layout viewport, under the
          keyboard), and the mic is when the page is scrolled with nothing
          to type. */}
      <div ref={dockRef} className={pinned ? "ask-dock is-pinned" : "ask-dock"}>
        {pinned && jumpButton}
        {pinned && (
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
            onKeyDown={(e) => e.key === "Enter" && send(input)}
          />
          {userId && (voice === "recording" ? (
            <button type="button" className="ask-send ask-mic recording" onClick={() => recording.current?.stop()} aria-label={t("field.stopRecording", { seconds })}>
              <Square size={16} /> <span className="ask-mic-seconds">{seconds}s</span>
            </button>
          ) : (
            <button type="button" className="ask-send ask-mic" disabled={thinking || voice !== "idle"} onClick={() => void startRecording()} aria-label={t("field.record")}>
              <Mic size={18} />
            </button>
          ))}
          <button type="button" className="ask-send" disabled={thinking || !input.trim()} onClick={() => send(input)} aria-label={t("ask.send")}>
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
