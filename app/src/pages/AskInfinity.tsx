import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { supabaseConfigured } from "../lib/supabase";
import { queryClient } from "../lib/queryClient";
import { askInfinity, liveAnswer, shouldUseLLM, type AskLiveData, type KnowledgeSource } from "../lib/knowledge";
import { askBrain, getBrainIndex, type BrainOutcome } from "../lib/brain/answer";
import { currentCatalog, refreshCatalogCache } from "../lib/brain/catalogCache";
import { logAskedQuestion } from "../lib/brain/askLog";
import type { BrainHit, CatalogType } from "../lib/brain/types";
import type { Profile, ProjectOpening } from "../lib/install/types";
import { isForemanPlus } from "../lib/install/types";
import type { Project } from "../lib/types";
import type { Issue } from "../lib/issues";
import type { ScheduleAssignment } from "../lib/schedule/types";
import type { ScheduleVehicleLink, VehicleWithMeta } from "../lib/vehicles/types";
import type { Trip } from "../lib/travel/types";

interface ChatMsg {
  who: "me" | "infinity";
  text: string;
  /** Citations from the cloud path. */
  sources?: KnowledgeSource[];
  /** Answers from the local brain, each with where it came from. */
  hits?: BrainHit[];
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
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [catalog, setCatalog] = useState<CatalogType[]>(() => currentCatalog().types);
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      who: "infinity",
      text:
        "Hey — ask me anything about a window type, a term, or how we install. " +
        "Answers come from our own notes, on this phone, so they work with no signal.",
    },
  ]);
  const [thinking, setThinking] = useState(false);
  const profile = queryClient.getQueryData<Profile>(["myProfile"]);
  const threadEnd = useRef<HTMLDivElement>(null);

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
    threadEnd.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const suggestions = useMemo(
    () => [
      "Single hung tips",
      "What is flashing?",
      "Do I caulk the bottom?",
      "Which side does the drain face?",
      "What's on our schedule?",
      "My next window",
    ],
    [],
  );

  const send = (text: string) => {
    const q = text.trim();
    if (!q || thinking) return;

    const history = messages
      .slice(1)
      .map((m) => ({
        role: m.who === "me" ? ("user" as const) : ("assistant" as const),
        content: m.text,
      }))
      .slice(-8);

    setMessages((m) => [...m, { who: "me", text: q }]);
    setInput("");
    setThinking(true);

    const online = typeof navigator === "undefined" ? true : navigator.onLine;

    const run = async (): Promise<ChatMsg> => {
      // 1) Live job data the app already has cached — schedule, next window,
      //    my truck. No network needed and no model involved.
      const live = liveAnswer(q, gatherLiveData());
      if (live) {
        void logAskedQuestion(q, { kind: "answers", hits: [] }, { online });
        return { who: "infinity", text: live };
      }

      // 2) The company brain. This is the answer path — always available,
      //    always free, and incapable of making something up.
      const outcome = askBrain(index, q);
      void logAskedQuestion(q, outcome, { online });
      if (outcome.kind === "answers") return brainMessage(outcome);

      // 3) Only when the brain has nothing written down, and only when the
      //    cloud AI is actually configured, offer what it can add. It is never
      //    a prerequisite for a correct answer and is skipped entirely with no
      //    key, offline, or for installers.
      let limitNote: string | undefined;
      if (shouldUseLLM({ online, supabaseConfigured }) && isForemanPlus(profile?.role)) {
        try {
          const { answer, sources, note } = await askInfinity(q, history);
          if (answer) return { who: "infinity", text: answer, sources };
          limitNote = note;
        } catch {
          // Cloud unavailable — the honest local message below stands.
        }
      }
      return brainMessage(outcome, limitNote);
    };

    void run()
      .then((reply) => setMessages((m) => [...m, reply]))
      .catch(() =>
        setMessages((m) => [
          ...m,
          { who: "infinity", text: "Something went wrong. Try again." },
        ]),
      )
      .finally(() => setThinking(false));
  };

  return (
    <div className="page ask-page">
      <header className="page-header">
        <div>
          <p className="home-greeting ai-eyebrow">
            <Sparkles size={13} /> Infinity
          </p>
          <h1>Company brain</h1>
        </div>
        <button type="button" className="back-chip" aria-label="Back" onClick={() => navigate(-1)}>
          ‹
        </button>
      </header>

      <div className="ask-thread">
        {messages.map((m, i) => (
          <div key={i} className={m.who === "me" ? "ask-msg mine" : "ask-msg"}>
            <div
              className={m.who === "me" ? "ask-bubble mine" : "ask-bubble"}
              style={{ whiteSpace: "pre-line" }}
            >
              {m.text}
            </div>
            {m.hits && m.hits.length > 0 && (
              <p className="ask-sources muted">From: {m.hits[0].entry.source}</p>
            )}
            {m.hits && m.hits.length > 1 && (
              <div className="ask-alternates">
                <p className="muted" style={{ margin: "4px 0 2px", fontSize: 12 }}>
                  Also written down:
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
                Sources: {m.sources.map((s) => s.title).join(", ")}
              </p>
            )}
          </div>
        ))}
        {thinking && (
          <div className="ask-bubble" aria-live="polite">
            …
          </div>
        )}
        <div ref={threadEnd} />
      </div>

      <div className="ask-suggestions">
        {suggestions.map((s) => (
          <button key={s} type="button" className="chip" onClick={() => send(s)}>
            {s}
          </button>
        ))}
      </div>

      <div className="ask-input">
        <input
          placeholder="Ask about a window, a term, or how-to…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(input)}
        />
        <button type="button" className="ask-send" onClick={() => send(input)} aria-label="Send">
          ↑
        </button>
      </div>
    </div>
  );
}
