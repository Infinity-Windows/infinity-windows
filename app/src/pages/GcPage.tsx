// The general contractor's own page (Wave H, H2).
//
// A builder opens this from a text message or an email. He has no account, no
// password, and never will. It renders BEFORE the session — ahead of the splash
// and the sign-in screen in App.tsx — because asking Supabase who he is would
// leave him at "Connecting…" for a question that has no answer.
//
// CUSTOMER-FACING, AND ENGLISH ONLY IN V1 BY DECISION. Every other screen in
// this app goes through t() with Spanish beside it, because the crew reads
// Spanish. This one is read by somebody who has never opened the app and never
// picked a language in it, and it renders before the language layer exists at
// all. When Spanish is wanted here it is a translation of this page and the
// email together — not a catalog entry.
//
// It talks to exactly one endpoint. Everything it knows arrives from the
// gc-link edge function, which builds its answer field by field on the service
// role: the job's name, which of our two brands to expect, the six questions
// with whatever was last answered, and the thread. There is no Supabase table
// read anywhere on this page, and the token grants access to none.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { GC_BRAND_NAMES, GC_SET_PREFERENCES, firstMissingAnswer, gcBrandOf } from "../lib/gc";
import type { GcCheckinDraft } from "../lib/gc";

/** The one sentence about a link that will not work. The same one the function
 * returns, kept here too so a page that cannot reach the network at all still
 * says something a builder can act on. */
const DEAD_LINK = "This link has expired — ask your installer for a new one.";

/** What the six questions complain with, in the order the page asks them. */
const MISSING_TEXT: Record<string, string> = {
  expectedEndDate: "Please say when you expect the house to be finished.",
  roofOnDate: "Please say when the roof goes on.",
  framingChecked: "Please say whether the framing has been checked.",
  setPreference: "Please say whether you want the windows inset or outset.",
  exteriorMaterial: "Please say what is going on the outside.",
  interiorMaterial: "Please say what is going on the inside.",
  channel: "Something went wrong — please try again.",
};

const SET_LABELS: Record<string, string> = {
  inset: "Inset",
  outset: "Outset",
  unknown: "I have not decided",
};

interface ThreadLine {
  id: string;
  from: string;
  body: string;
  at: string;
}

interface PriorAnswers {
  answeredAt: string;
  expectedEndDate: string | null;
  roofOnDate: string | null;
  framingChecked: boolean | null;
  setPreference: string | null;
  exteriorMaterial: string | null;
  interiorMaterial: string | null;
  contactName: string | null;
}

interface PageData {
  job: string;
  brand: string;
  answers: PriorAnswers | null;
  thread: ThreadLine[];
}

const EMPTY: GcCheckinDraft = {
  expectedEndDate: "",
  roofOnDate: "",
  framingChecked: null,
  setPreference: "",
  exteriorMaterial: "",
  interiorMaterial: "",
  contactName: "",
  notes: "",
};

/** Ask the edge function something. Never throws — a builder on a job site with
 * one bar gets a sentence, not a white screen. */
async function ask(
  token: string,
  payload: Record<string, unknown>,
): Promise<{ data: PageData | null; error: string | null }> {
  try {
    const { data, error } = await supabase.functions.invoke("gc-link", {
      body: { token, ...payload },
    });
    if (error) {
      const res = (error as { context?: { json?: () => Promise<unknown> } })?.context;
      try {
        const body = (await res?.json?.()) as { error?: unknown } | undefined;
        if (typeof body?.error === "string" && body.error) {
          return { data: null, error: body.error };
        }
      } catch {
        // No JSON body — fall through.
      }
      return { data: null, error: DEAD_LINK };
    }
    return { data: (data ?? null) as PageData | null, error: null };
  } catch {
    return { data: null, error: "We could not reach us just now — please try again." };
  }
}

export function GcPage({ token }: { token: string }) {
  const [page, setPage] = useState<PageData | null>(null);
  const [dead, setDead] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<GcCheckinDraft>(EMPTY);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [thanks, setThanks] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await ask(token, { action: "open" });
    if (error || !data) setDead(error ?? DEAD_LINK);
    else {
      setPage(data);
      // Prefill from the last answers, whoever gave them. A builder who is
      // correcting one date should not have to retype the other five.
      const prior = data.answers;
      if (prior) {
        setDraft({
          expectedEndDate: prior.expectedEndDate ?? "",
          roofOnDate: prior.roofOnDate ?? "",
          framingChecked: prior.framingChecked,
          setPreference: prior.setPreference ?? "",
          exteriorMaterial: prior.exteriorMaterial ?? "",
          interiorMaterial: prior.interiorMaterial ?? "",
          contactName: prior.contactName ?? "",
          notes: "",
        });
      }
    }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const brand = gcBrandOf(page?.brand);
  const company = GC_BRAND_NAMES[brand];

  const submit = async () => {
    // The page's copy of the rule the RPC enforces — it saves a round trip and
    // puts the message beside the empty box. The server checks all six again.
    const missing = firstMissingAnswer({ ...draft, channel: undefined });
    if (missing) {
      setProblem(MISSING_TEXT[missing] ?? MISSING_TEXT.channel);
      return;
    }
    setProblem(null);
    setSending(true);
    const { error } = await ask(token, {
      action: "answer",
      expectedEndDate: draft.expectedEndDate,
      roofOnDate: draft.roofOnDate,
      framingChecked: draft.framingChecked,
      setPreference: draft.setPreference,
      exteriorMaterial: draft.exteriorMaterial.trim(),
      interiorMaterial: draft.interiorMaterial.trim(),
      contactName: (draft.contactName ?? "").trim() || null,
      notes: (draft.notes ?? "").trim() || null,
    });
    setSending(false);
    if (error) setProblem(error);
    else {
      setThanks(true);
      await load();
    }
  };

  const say = async () => {
    if (!message.trim()) return;
    setSending(true);
    const { error } = await ask(token, { action: "say", message: message.trim() });
    setSending(false);
    if (error) setProblem(error);
    else {
      setMessage("");
      setNote("Sent. Somebody on the job will see it.");
      await load();
    }
  };

  if (loading) {
    return (
      <div className="page" style={{ padding: 24, textAlign: "center" }}>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (dead || !page) {
    return (
      <div className="page" style={{ padding: 24, maxWidth: 560, margin: "0 auto" }}>
        <h1 style={{ marginTop: 0 }}>{GC_BRAND_NAMES.stg}</h1>
        <p>{dead ?? DEAD_LINK}</p>
      </div>
    );
  }

  return (
    <div className="page" style={{ padding: 20, maxWidth: 560, margin: "0 auto" }}>
      <header style={{ marginBottom: 16 }}>
        {/* The brand the office chose for this job (Q20). One company, two
            names, and the wrong one is the kind of small wrong thing that makes
            a customer wonder who they are dealing with. */}
        <p className="muted" style={{ margin: 0, letterSpacing: "0.04em" }}>{company}</p>
        <h1 style={{ margin: "4px 0 0" }}>{page.job}</h1>
      </header>

      <p>
        We are getting ready for the windows and doors on this job. Six answers
        is all we need, and they go straight to the crew who will be on site.
      </p>

      {thanks && (
        <p className="wh-row-sub" style={{ fontWeight: 600 }}>
          Thank you — the crew has it. You can change any of these later on the
          same link.
        </p>
      )}

      {page.answers && !thanks && (
        <p className="muted">
          Last answered {new Date(page.answers.answeredAt).toLocaleDateString()}. Change
          anything that has moved.
        </p>
      )}

      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
        <label className="field">
          <span className="field-label">When do you expect the house to be finished?</span>
          <input
            type="date"
            aria-label="When do you expect the house to be finished?"
            value={draft.expectedEndDate}
            onChange={(e) => setDraft({ ...draft, expectedEndDate: e.target.value })}
          />
        </label>

        <label className="field">
          <span className="field-label">When does the roof go on?</span>
          <input
            type="date"
            aria-label="When does the roof go on?"
            value={draft.roofOnDate}
            onChange={(e) => setDraft({ ...draft, roofOnDate: e.target.value })}
          />
        </label>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">Has the framing been checked?</legend>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            <button
              type="button"
              className={draft.framingChecked === true ? "button-like active-pill" : "button-like"}
              onClick={() => setDraft({ ...draft, framingChecked: true })}
            >
              Yes
            </button>
            <button
              type="button"
              className={draft.framingChecked === false ? "button-like active-pill" : "button-like"}
              onClick={() => setDraft({ ...draft, framingChecked: false })}
            >
              Not yet
            </button>
          </div>
        </fieldset>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">Do you want the windows inset or outset?</legend>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {GC_SET_PREFERENCES.map((value) => (
              <button
                key={value}
                type="button"
                className={draft.setPreference === value ? "button-like active-pill" : "button-like"}
                onClick={() => setDraft({ ...draft, setPreference: value })}
              >
                {SET_LABELS[value]}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="field">
          <span className="field-label">What is going on the outside?</span>
          <input
            type="text"
            aria-label="What is going on the outside?"
            placeholder="Stucco, stone, siding…"
            value={draft.exteriorMaterial}
            onChange={(e) => setDraft({ ...draft, exteriorMaterial: e.target.value })}
          />
        </label>

        <label className="field">
          <span className="field-label">What is going on the inside?</span>
          <input
            type="text"
            aria-label="What is going on the inside?"
            placeholder="Drywall, plaster, wood…"
            value={draft.interiorMaterial}
            onChange={(e) => setDraft({ ...draft, interiorMaterial: e.target.value })}
          />
        </label>

        <label className="field">
          <span className="field-label">Your name</span>
          <input
            type="text"
            aria-label="Your name"
            value={draft.contactName ?? ""}
            onChange={(e) => setDraft({ ...draft, contactName: e.target.value })}
          />
        </label>

        <label className="field">
          <span className="field-label">Anything else we should know</span>
          <textarea
            aria-label="Anything else we should know"
            rows={2}
            value={draft.notes ?? ""}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </label>

        <button
          type="button"
          className="action-btn"
          style={{ minHeight: 48 }}
          disabled={sending}
          onClick={() => void submit()}
        >
          {sending ? "Sending…" : "Send these to the crew"}
        </button>
      </div>

      {problem && <p className="error">{problem}</p>}

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: "1.05rem" }}>Ask us something</h2>
        <p className="muted">
          Write here rather than replying to the email — it reaches the crew on
          the job, and we answer you on this page.
        </p>

        {page.thread.map((line) => (
          <div key={line.id} style={{ margin: "8px 0" }}>
            <p className="field-label" style={{ margin: 0 }}>
              {line.from === "you" ? "You" : company}
              {" · "}
              {new Date(line.at).toLocaleDateString()}
            </p>
            <p style={{ margin: 0 }}>{line.body}</p>
          </div>
        ))}

        <textarea
          aria-label="Ask us something"
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          style={{ width: "100%" }}
        />
        <button
          type="button"
          className="action-btn"
          style={{ minHeight: 48, marginTop: 8 }}
          disabled={sending || !message.trim()}
          onClick={() => void say()}
        >
          Send
        </button>
        {note && <p className="wh-row-sub">{note}</p>}
      </section>
    </div>
  );
}
