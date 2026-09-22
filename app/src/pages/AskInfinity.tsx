import {useQuery} from "@tanstack/react-query";
import {getRealProfile} from "../lib/install/api";
import {LearningPanel} from "../components/hexPortal/LearningPanel";
import {LearningCard} from "../components/hexPortal/LearningCard";
import {findPortalGuidance,type PortalSource,type LearningDraft} from "../lib/hexPortal";
import "../components/hexPortal/hexPortal.css";
import type { AskArtifact } from "../../../supabase/functions/_shared/askReporting.ts";
import { ReportCard } from "../components/ask/ReportCard";
import { isOperationalAsk } from "../lib/askRouting";
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
import { useT, useLanguage } from "../lib/i18n";

interface ChatMsg {
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

  const send = (text: string) => {
    const q = text.trim();
    if (!q || thinking) return;

    const history = messages
      .slice(1)
      .map((m) => ({
        role: m.who === "me" ? ("user" as const) : ("assistant" as const),
        content: m.text + (m.artifacts?.length ? "\nReport filters/IDs for follow-up (re-query before answering): " + JSON.stringify(m.artifacts.map(a => a.kind === "time_report" ? { scope:a.scope,people:a.people,jobs:a.jobs } : { project:a.project })) : ""),
      }))
      .slice(-8);

    setMessages((m) => [...m, { who: "me", text: q }]);
    setInput("");
    setThinking(true);

    const online = typeof navigator === "undefined" ? true : navigator.onLine;

    const operationalQuestion = isOperationalAsk(q, messages.some(m => Boolean(m.artifacts?.length)));
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
      const operational = isOperationalAsk(q, messages.some(m => Boolean(m.artifacts?.length)));
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
        try {
          const { answer, sources, note, toolActivity, artifacts } = await askInfinity(q, history);
          if (answer || artifacts?.length) return { who: "infinity", text: answer, sources, toolActivity, artifacts };
          limitNote = note;
        } catch {
          limitNote = t("ask.report.cloudError");
        }
      }
      if (operational) return { who: "infinity", text: limitNote || t(online ? "ask.report.cloudError" : "ask.report.offline") };
      return brainMessage(outcome, limitNote);
    };

    void run()
      .then((reply) => setMessages((m) => [...m, {...reply,portalNotice,...learningContext&&!reply.artifacts?.length?{learning:{...learningContext,answer:reply.text,sources:reply.portalSources??(reply.sources?.length?reply.sources.map(source=>({id:source.path.slice(0,160),title:source.title.slice(0,300),kind:"reference" as const})):(reply.hits??[]).map(hit=>({id:hit.entry.id.slice(0,160),title:hit.entry.title.slice(0,300),kind:"reference" as const})))}}:{}}]))
      .catch(() =>
        setMessages((m) => [
          ...m,
          { who: "infinity", text: t("ask.somethingWentWrong") },
        ]),
      )
      .finally(() => setThinking(false));
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
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(input)}
        />
        <button type="button" className="ask-send" disabled={thinking || !input.trim()} onClick={() => send(input)} aria-label={t("ask.send")}>
          ↑
        </button>
      </div>
    </div>
  );
}
