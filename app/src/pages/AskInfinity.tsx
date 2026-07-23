import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { CATS, TERMS } from "../lib/glossary";
import { searchBrainTypes } from "../lib/api";
import type { WindowType } from "../lib/types";
import { supabaseConfigured } from "../lib/supabase";
import {
  askInfinity,
  shouldUseLLM,
  type KnowledgeSource,
} from "../lib/knowledge";

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

  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // The offline brain can't answer "what's on our schedule" (it has no live app
  // data), so only offer that chip when the cloud Ask path is actually usable.
  const canAskLive = shouldUseLLM({ online, supabaseConfigured });
  const suggestions = useMemo(() => {
    const base = ["Single hung tips", "What is flashing?"];
    return canAskLive ? ["What's on our schedule?", ...base] : base;
  }, [canAskLive]);

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
      if (useCloud) {
        try {
          const { answer, sources } = await askInfinity(q, history);
          if (answer) return { who: "infinity", text: answer, sources };
        } catch {
          // Cloud unavailable — fall back to the offline brain below.
        }
      }
      return { who: "infinity", text: await localAnswer(q) };
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
