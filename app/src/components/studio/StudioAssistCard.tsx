// Studio 100x #42: the "🤖 Ask about this model" chat card. Deliberately
// LEAN — Ask Infinity's page (src/pages/AskInfinity.tsx) turned out not to
// be cheaply reusable (its state is tangled up with the offline "brain" and
// live job-data cache, neither of which apply here), so this is a minimal
// message list + input built straight on the same CSS the ask page already
// uses (.ask-thread/.ask-bubble/.ask-input/.ask-send) plus the Studio's own
// .modal-card/.studio-card — no new CSS needed anywhere in this file.
//
// The one thing Ask Infinity doesn't have: a reply may carry a proposed
// change. When it does, insertUnit is what actually applies it — the SAME
// path a catalog drag-drop uses (see ModelStudio.tsx), so an AI suggestion
// gets every validation a human placement already gets (placeInRoom,
// snapIfCorner, growWallToFit). This card only ever resolves {wall, xCm}
// into a point and hands it to that path; it never touches the model itself.

import { useEffect, useRef, useState } from "react";
import {
  askStudioAssist,
  defaultUnitName,
  describeProposal,
  parseAddUnitProposal,
  resolveWallPoint,
  serializeFloorForAI,
  type AddUnitProposal,
} from "../../lib/modelstudio/aiAssist";
import type { Blueprint3d } from "../../lib/modelstudio/core";
import type { StudioUnit, UnitConfig } from "../../lib/modelstudio/units";

interface ChatMsg {
  who: "me" | "ai";
  text: string;
  /** Set when this reply carried a well-formed add_unit block. */
  proposal?: AddUnitProposal;
  /** Set once the person acts on the card — hides Insert/Dismiss after. */
  proposalDone?: "inserted" | "dismissed";
}

const GREETING: ChatMsg = {
  who: "ai",
  text:
    "Ask me about this floor's model — counts, sizes, what's on which wall — " +
    "or ask me to add a unit and I'll propose it here first.",
};

export function StudioAssistCard({
  bp,
  units,
  onInsert,
  onClose,
}: {
  bp: Blueprint3d | null;
  units: StudioUnit[];
  /** The SAME insertUnit the catalog's drag-drop and Insert button call. */
  onInsert: (config: UnitConfig, name: string, atCm?: { x: number; y: number }) => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const threadEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = (raw: string) => {
    const q = raw.trim();
    if (!q || thinking) return;
    setInput("");

    if (!bp) {
      setMessages((m) => [
        ...m,
        { who: "me", text: q },
        { who: "ai", text: "Still loading the model — try again in a moment." },
      ]);
      return;
    }

    const history = messages
      .filter((m) => m !== GREETING)
      .map((m) => ({
        role: m.who === "me" ? ("user" as const) : ("assistant" as const),
        content: m.text,
      }))
      .slice(-8);

    setMessages((m) => [...m, { who: "me", text: q }]);
    setThinking(true);

    const payload = serializeFloorForAI(
      bp,
      units.map((u) => ({ name: u.name, config: u.config })),
    );

    askStudioAssist(q, payload, history)
      .then((res) => {
        if (!res.answer) {
          setMessages((m) => [
            ...m,
            { who: "ai", text: res.note || "No answer right now — try again in a moment." },
          ]);
          return;
        }
        const { prose, proposal } = parseAddUnitProposal(res.answer);
        const prefix = res.note ? `${res.note}\n\n` : "";
        setMessages((m) => [
          ...m,
          { who: "ai", text: prefix + prose, proposal: proposal ?? undefined },
        ]);
      })
      .catch(() => setMessages((m) => [...m, { who: "ai", text: "Something went wrong. Try again." }]))
      .finally(() => setThinking(false));
  };

  const handleInsert = (index: number, proposal: AddUnitProposal) => {
    if (!bp) return;
    const point = resolveWallPoint(bp.model.floorplan.walls, proposal.wall, proposal.xCm);
    if (!point) {
      setMessages((m) => [
        ...m.map((msg, i) => (i === index ? { ...msg, proposalDone: "dismissed" as const } : msg)),
        { who: "ai", text: "That wall isn't on the model anymore — ask again." },
      ]);
      return;
    }
    onInsert(proposal.config as UnitConfig, defaultUnitName(proposal.config), point);
    setMessages((m) =>
      m.map((msg, i) => (i === index ? { ...msg, proposalDone: "inserted" as const } : msg)),
    );
  };

  const handleDismiss = (index: number) => {
    setMessages((m) =>
      m.map((msg, i) => (i === index ? { ...msg, proposalDone: "dismissed" as const } : msg)),
    );
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Ask about this model"
      onClick={onClose}
    >
      <div className="modal-card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="row-gap" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <p style={{ margin: 0, fontWeight: 700 }}>🤖 Ask about this model</p>
          <button type="button" className="button-like studio-mini" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="ask-thread" style={{ maxHeight: 360, overflowY: "auto" }}>
          {messages.map((m, i) => (
            <div key={i} className={m.who === "me" ? "ask-msg mine" : "ask-msg"}>
              <div
                className={m.who === "me" ? "ask-bubble mine" : "ask-bubble"}
                style={{ whiteSpace: "pre-line" }}
              >
                {m.text}
              </div>
              {m.proposal && (
                <div className="studio-card" style={{ marginTop: 6, maxWidth: "82%" }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>Add this unit?</p>
                  <p className="muted" style={{ margin: "2px 0 0", fontSize: 12.5 }}>
                    {describeProposal(bp ? bp.model.floorplan.walls : [], m.proposal)}
                  </p>
                  {!m.proposalDone ? (
                    <div className="row-gap" style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        className="button-like studio-mini active-pill"
                        onClick={() => handleInsert(i, m.proposal as AddUnitProposal)}
                      >
                        Insert
                      </button>
                      <button
                        type="button"
                        className="button-like studio-mini"
                        onClick={() => handleDismiss(i)}
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : (
                    <p className="muted" style={{ margin: "6px 0 0", fontSize: 11.5 }}>
                      {m.proposalDone === "inserted" ? "Inserted." : "Dismissed."}
                    </p>
                  )}
                </div>
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

        <div className="ask-input">
          <input
            placeholder="Ask about this model…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send(input)}
          />
          <button type="button" className="ask-send" onClick={() => send(input)} aria-label="Send">
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
