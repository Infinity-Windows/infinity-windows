import {useQuery} from "@tanstack/react-query";
import {getRealProfile} from "../lib/install/api";
import {LearningPanel} from "../components/hexPortal/LearningPanel";
import {LearningCard} from "../components/hexPortal/LearningCard";
import {findPortalGuidance,type PortalSource,type LearningDraft} from "../lib/hexPortal";
import "../components/hexPortal/hexPortal.css";
import type { AskArtifact } from "../../../supabase/functions/_shared/askReporting.ts";
import { ReportCard } from "../components/ask/ReportCard";
import { asksForReport, isOperationalAsk } from "../lib/askRouting";
import { cleanAskText } from "../lib/cleanAskText";
import { BackChip } from "../components/BackChip";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { supabaseConfigured } from "../lib/supabase";
import { queryClient } from "../lib/queryClient";
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
import { Mic, Square } from "lucide-react";
import type { TimeShift } from "../lib/timeclock";

// Every cached screen a field receipt may have changed (see FIELD_QUERY_ROOTS).
const refreshFieldViews = () => { for (const root of FIELD_QUERY_ROOTS) void queryClient.invalidateQueries({ queryKey: [root] }); };

interface ChatMsg {
  /** Field work: database receipts and the checklist, never model claims. */
  field?: FieldReply;
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
  const [learningJob,setLearningJob]=useState("");
  const [learningUnit,setLearningUnit]=useState("");
  const [input, setInput] = useState("");
  const [catalog, setCatalog] = useState<CatalogType[]>(() => currentCatalog().types);
  const [messages, setMessages] = useState<ChatMsg[]>([
    { who: "infinity", text: t("ask.greeting") },
  ]);
  const [thinking, setThinking] = useState(false);
  const threadEnd = useRef<HTMLDivElement>(null);
  const lastMessageCount = useRef(1);
  const location = useLocation();

  // --- Field work -----------------------------------------------------------
  // Everything below is scoped to the REAL signed-in account (not "view as"):
  // another person signing in on this phone sees none of it.
  const userId = profile.data?.id ?? null;
  const [conversation, setConversation] = useState<string | null>(null);
  const [unsent, setUnsent] = useState<UnsentField[]>([]);
  const [voice, setVoice] = useState<"idle" | "recording" | "saving" | "transcribing">("idle");
  const [seconds, setSeconds] = useState(0);
  const [voiceError, setVoiceError] = useState("");
  const [restoreError, setRestoreError] = useState(false);
  const recording = useRef<VoiceRecording | null>(null);
  const recordAbort = useRef<AbortController | null>(null);
  /** A recording the phone could not keep yet: held in memory until it is
   * saved on the phone or on the server, never silently dropped. */
  const [held, setHeld] = useState<{ blob: Blob; meta: FieldMeta } | null>(null);
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
  const resetFieldUi = () => {
    gen.current += 1;
    recordAbort.current?.abort();
    recording.current?.cancel();
    recording.current = null;
    clockSeen.current = null;
    setInput(""); setVoice("idle"); setThinking(false); setVoiceError(""); setRestoreError(false); setHeld(null);
    setMessages([{ who: "infinity", text: t("ask.greeting") }]);
    return gen.current;
  };

  useEffect(() => {
    const g = resetFieldUi();
    actor.current = userId;
    setUnsent([]);
    setConversation(null);
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
            restored.push({ who: "infinity", text: turn.reply?.answer ?? "", toolActivity: turn.reply?.toolActivity,
              artifacts: (turn.reply?.artifacts ?? []).filter((a) => a && ["time_report", "job_summary"].includes(a.kind)).slice(0, 4),
              sources: turn.reply?.sources ?? [],
              field: { request_id: turn.id, receipts: turn.receipts, checklist: turn.captured?.checklist ?? null } });
        }
        return [m[0], ...restored, ...m.slice(1)];
      });
    }).catch(() => { if (isCurrent(g)) setRestoreError(true); });
    return () => { recordAbort.current?.abort(); recording.current?.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const fieldActive = messages.some((m) => !!m.field);
  const latestChecklist = [...messages].reverse().find((m) => m.field?.checklist)?.field?.checklist ?? null;
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
    return { actor_id: uid, request_id: base.requestId, conversation_id: conversation, input_kind: kind, sent_at: base.sentAt, clock_version: base.clockVersion, clock_pending_sync: pending, audio_path: null };
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
    const seed = (location.state as { seed?: string } | null)?.seed;
    if (typeof seed === "string" && seed) setInput(seed);
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

  useEffect(() => {
    // New replies may arrive while the person is reading an earlier answer.
    // Follow only when already near the end; never scroll on initial mount.
    const end = threadEnd.current;
    if (messages.length > lastMessageCount.current && end && end.getBoundingClientRect().top < window.innerHeight + 220) {
      end.scrollIntoView({ block: "nearest" });
    }
    lastMessageCount.current = messages.length;
  }, [messages]);

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

  const send = (text: string, voiceMeta?: FieldMeta, sentFrom = gen.current) => {
    const q = text.trim();
    if (!q || thinking || !isCurrent(sentFrom)) return;
    const g = gen.current;
    const uid = actor.current;
    // Send was pressed now; this is the time and clock view the request carries.
    const operationalNow = !!voiceMeta || isOperationalAsk(q, messages.some(m => Boolean(m.artifacts?.length)) || fieldActive);
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
    // A voice message sends itself when transcription finishes; whatever the
    // person typed meanwhile is theirs and stays in the box.
    if (!voiceMeta) setInput("");
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
          const { answer, sources, note, toolActivity, artifacts, field } = await askInfinity(q, history, meta ?? undefined);
          if (meta) {
            void dropUnsent(meta.request_id).then(async () => { if (isCurrent(g) && uid) setUnsent(await listUnsent(uid)); }).catch(() => undefined);
            if (isCurrent(g)) { clockSeen.current = null; readClockNow(g); }
            // The request now holds the recording: the in-memory copy can go.
            if (isCurrent(g) && field) setHeld((h) => (h?.meta.request_id === meta.request_id ? null : h));
            if (field?.receipts.length) refreshFieldViews();
          }
          if (answer || artifacts?.length || field?.receipts.length || field?.checklist) return { who: "infinity", text: answer || note || "", sources, toolActivity, artifacts, field };
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
        return transcribeDescription(blob, lang, abort.signal);
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
    readClockNow(g);
    recordAbort.current = new AbortController();
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
    resetFieldUi();
    setConversation(startNewConversation(uid));
    readClockNow();
  };

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

      <LearningPanel projectId={learningJob} unitLabel={learningUnit} actorId={profile.data?.id} onProject={setLearningJob} onUnit={setLearningUnit}/>
      <div className="ask-thread">
        {messages.map((m, i) => (
          <div key={i} className={m.who === "me" ? "ask-msg mine" : "ask-msg"}>
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
        <div role="status" aria-live="polite" className={thinking ? "ask-bubble" : undefined}>
          {thinking ? (es ? "Buscando una respuesta…" : "Finding an answer…") : ""}
        </div>
        <div ref={threadEnd} />
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
      {voice === "saving" && <p role="status" className="muted">{t("field.savingMemo")}</p>}
      {voice === "transcribing" && <p role="status" className="muted">{t("field.transcribing")}</p>}

      <div className="ask-suggestions">
        {suggestions.map((s) => (
          <button key={s.query} type="button" className="chip" onClick={() => send(s.query)}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="ask-input">
        <input
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
  );
}
