import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { CATS, TERMS } from "../lib/glossary";
import { searchBrainTypes } from "../lib/api";
import type { Project, WindowType } from "../lib/types";
import { supabaseConfigured } from "../lib/supabase";
import { queryClient } from "../lib/queryClient";
import {
  askInfinity,
  liveAnswer,
  shouldUseLLM,
  type AskLiveData,
  type KnowledgeSource,
} from "../lib/knowledge";
import type { Profile, ProjectOpening } from "../lib/install/types";
import type { Issue } from "../lib/issues";
import type { ScheduleAssignment } from "../lib/schedule/types";
import type { ScheduleVehicleLink, VehicleWithMeta } from "../lib/vehicles/types";
import type { Trip } from "../lib/travel/types";

interface ChatMsg {
  who: "me" | "infinity";
  text: string;
  sources?: KnowledgeSource[];
}

/**
 * Ask Infinity — real, business-specific AI. It calls the cloud `ask` function
 * (RAG over the company's Obsidian vault + live app data, grounded with
 * citations) and, whenever that's unavailable (offline, not configured, or an
 * error), transparently falls back to the bundled offline brain: the closed
 * install catalog (per-type tips, watch-outs, difficulty, median time), then
 * the window glossary + app guide. The chat therefore never goes dark.
 */
const APP_GUIDE =
  "Home is your day: clock-in, term of the day, active install, points and your projects. " +
  "Work is your assigned queue — the next ready window is up top. " +
  "Warehouse is find/scan/receive/slots and per-job pick lists. " +
  "Open a project to see its plan; tap a unit dot (blue = window, green = door) to open its sheet, then Assign to me & start. " +
  "After an install: record a voice memo, attach a video, take proof photos — points release after QC sign-off. " +
  "Learn has the glossary and daily practice; Points shows your score and tier.";

function brainAnswer(t: WindowType): string {
  const lines: string[] = [];
  const size =
    t.width_in && t.height_in ? ` (${t.width_in}×${t.height_in})` : "";
  lines.push(`${t.name}${size} — ${t.type_code}`);

  const diff = t.difficulty_rating ?? t.learned_difficulty;
  const bits: string[] = [];
  if (diff != null) bits.push(`difficulty ${Math.round(Number(diff))}/5`);
  if (t.median_minutes != null)
    bits.push(`~${Math.round(Number(t.median_minutes))} min typical`);
  if (t.n_installs) bits.push(`${t.n_installs} installs logged`);
  if (bits.length) lines.push(bits.join(" · "));

  const tips = t.tips_json ?? [];
  if (tips.length) {
    lines.push("");
    lines.push("Tips:");
    tips.slice(0, 5).forEach((tip) => lines.push(`• ${tip}`));
  }
  const watch = t.watch_outs_json ?? [];
  if (watch.length) {
    lines.push("");
    lines.push("Watch out:");
    watch.slice(0, 5).forEach((w) => lines.push(`⚠ ${w}`));
  }
  if (!tips.length && !watch.length) {
    lines.push("");
    lines.push(
      "No install tips saved for this type yet — they build up as crews log installs and voice memos.",
    );
  }
  return lines.join("\n");
}

/** Offline fallback: real-brain first, then glossary, then app guide. */
async function localAnswer(q: string): Promise<string> {
  const query = q.toLowerCase().trim();
  if (!query) return "Ask me about a window type, a term, or how to use any part of the app.";

  // 1) The real install brain: does the query name a catalog window type?
  try {
    const hits = await searchBrainTypes(q);
    if (hits.length > 0) {
      if (hits.length === 1) return brainAnswer(hits[0]);
      const top = brainAnswer(hits[0]);
      const others = hits
        .slice(1)
        .map((h) => `${h.type_code} (${h.name})`)
        .join(", ");
      return `${top}\n\nAlso matched: ${others} — ask for one by its code for details.`;
    }
  } catch {
    // Brain unreachable (offline) — fall through to the local knowledge base.
  }

  // 2) Window glossary term.
  const term = TERMS.find(
    (t) => query.includes(t.term.toLowerCase()) || t.term.toLowerCase().includes(query),
  );
  if (term) {
    const cat = CATS.find((c) => c.id === term.cat)?.label ?? term.cat;
    return `${term.term} (${cat}): ${term.desc}`;
  }

  // 3) How-to / app guide.
  if (/\b(how|where|what|use|do i|help|start|clock|install|point|scan|warehouse)\b/.test(query)) {
    return APP_GUIDE;
  }

  return (
    "I don't have a saved answer for that yet. Try a window type (e.g. \"single hung\", " +
    "\"SL7248\", \"bay\"), a term (e.g. \"flashing\", \"nail fin\"), or ask how to do " +
    "something in the app."
  );
}

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

export function AskInfinity() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      who: "infinity",
      text: "Hey — I'm Infinity AI. Ask me anything about our jobs, our notes, a window type, or how to use the app.",
    },
  ]);

  const [thinking, setThinking] = useState(false);

  // The offline fallback now grounds itself in the live query cache, so the
  // schedule/next-window chips answer even when the cloud path is unavailable.
  const suggestions = useMemo(
    () => [
      "What's on our schedule?",
      "My next window",
      "My truck today",
      "Travel this week",
      "Single hung tips",
      "What is flashing?",
    ],
    [],
  );

  const send = (text: string) => {
    const q = text.trim();
    if (!q || thinking) return;

    // History for the LLM: the running conversation so far (skip the greeting).
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
    const useCloud = shouldUseLLM({ online, supabaseConfigured });

    const run = async (): Promise<ChatMsg> => {
      // Only true when the cloud AI was expected to answer but actually errored
      // (network / outage / 500) — used to be honest that we've dropped to the
      // offline brain, rather than silently passing a canned tour off as the AI.
      let cloudErrored = false;
      if (useCloud) {
        try {
          const { answer, sources } = await askInfinity(q, history);
          if (answer) return { who: "infinity", text: answer, sources };
        } catch {
          // Cloud unavailable — fall back to the offline brain below, and note it.
          cloudErrored = true;
        }
      }
      // Ground the offline path in live cached data first, then the static brain.
      const prefix = cloudErrored ? "(Offline mode — cloud AI unavailable.)\n\n" : "";
      const live = liveAnswer(q, gatherLiveData());
      if (live) return { who: "infinity", text: prefix + live };
      return { who: "infinity", text: prefix + (await localAnswer(q)) };
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
            <Sparkles size={13} /> Infinity AI
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
          placeholder="Ask about jobs, notes, or how-to…"
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
