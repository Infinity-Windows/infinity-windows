import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CATS, TERMS } from "../lib/glossary";

interface ChatMsg {
  who: "me" | "infinity";
  text: string;
}

/**
 * Ask Infinity — answers from the local knowledge base (glossary + app guide)
 * for now. A real AI relay endpoint (set in Admin) can be wired later; until
 * then this gives useful offline answers instead of a dead screen.
 */
const APP_GUIDE =
  "Home is your day: clock-in, term of the day, active install, points and your projects. " +
  "Work is your assigned queue — the next ready window is up top. " +
  "Warehouse is find/scan/receive/slots and per-job pick lists. " +
  "Open a project to see its plan; tap a unit dot (blue = window, green = door) to open its sheet, then Assign to me & start. " +
  "After an install: record a voice memo, attach a video, take proof photos — points release after QC sign-off. " +
  "Learn has the glossary and daily practice; Points shows your score and tier.";

function localAnswer(q: string): string {
  const query = q.toLowerCase().trim();
  if (!query) return "Ask me about a window term, or how to use any part of the app.";

  const term = TERMS.find(
    (t) => query.includes(t.term.toLowerCase()) || t.term.toLowerCase().includes(query),
  );
  if (term) {
    const cat = CATS.find((c) => c.id === term.cat)?.label ?? term.cat;
    return `${term.term} (${cat}): ${term.desc}`;
  }

  if (/\b(how|where|what|use|do i|help|start|clock|install|point|scan|warehouse)\b/.test(query)) {
    return APP_GUIDE;
  }

  return (
    "I don't have a saved answer for that yet. An AI relay can be connected in Admin for " +
    "live answers. Meanwhile, try a window term (e.g. \"flashing\", \"nail fin\") or ask how to " +
    "do something in the app."
  );
}

export function AskInfinity() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      who: "infinity",
      text: "Hey — I'm Infinity. Ask me a window term or how to use the app.",
    },
  ]);

  const suggestions = useMemo(
    () => ["What is flashing?", "How do I start an install?", "Where do points come from?"],
    [],
  );

  const send = (text: string) => {
    const q = text.trim();
    if (!q) return;
    setMessages((m) => [
      ...m,
      { who: "me", text: q },
      { who: "infinity", text: localAnswer(q) },
    ]);
    setInput("");
  };

  return (
    <div className="page ask-page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Ask Infinity</p>
          <h1>Company brain</h1>
        </div>
        <button type="button" className="back-chip" aria-label="Back" onClick={() => navigate(-1)}>
          ‹
        </button>
      </header>

      <div className="ask-thread">
        {messages.map((m, i) => (
          <div key={i} className={m.who === "me" ? "ask-bubble mine" : "ask-bubble"}>
            {m.text}
          </div>
        ))}
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
          placeholder="Ask a term or how-to…"
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
