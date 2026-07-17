import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getMyProfile } from "../lib/install/api";
import { isLeadLike } from "../lib/install/types";
import {
  buildDeck,
  CATS,
  knowledgeScore,
  nextStepQuestion,
  quizQuestion,
  TERMS,
  type ProcStep,
  type Term,
} from "../lib/glossary";
import {
  addPriorityTerm,
  listMyProgress,
  listPriorityTerms,
  recordCard,
} from "../lib/learn";
import { awardPoints, POINT_RULES } from "../lib/points";

type Tab = "daily" | "quiz" | "sequence" | "glossary";

export function Education() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const lead = isLeadLike(me.data?.role);
  const progress = useQuery({
    queryKey: ["learnProgress", me.data?.id],
    queryFn: () => listMyProgress(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  const priority = useQuery({ queryKey: ["priorityTerms"], queryFn: listPriorityTerms });

  const [tab, setTab] = useState<Tab>("daily");

  const score = knowledgeScore(progress.data ?? []);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Education</h1>
        <Link to="/" className="button-like">Home</Link>
      </header>
      <p className="muted">Learn it before you install it.</p>

      <div className="stat-grid">
        <div className="stat-card"><span className="stat-num">{score}</span><span>knowledge score</span></div>
        <div className="stat-card"><span className="stat-num">{TERMS.length}</span><span>terms</span></div>
      </div>

      <nav className="hub-tabs">
        {(["daily", "quiz", "sequence", "glossary"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "hub-tab active" : "hub-tab"} onClick={() => setTab(t)}>
            {t === "daily" ? "Daily 5" : t === "quiz" ? "Quiz" : t === "sequence" ? "Sequence" : "Glossary"}
          </button>
        ))}
      </nav>

      {tab === "daily" && (
        <Daily
          profileId={me.data?.id}
          progress={progress.data ?? []}
          priorityIds={priority.data ?? []}
          onDone={() => queryClient.invalidateQueries({ queryKey: ["learnProgress"] })}
        />
      )}
      {tab === "quiz" && <Quiz profileId={me.data?.id} />}
      {tab === "sequence" && <Sequence profileId={me.data?.id} />}
      {tab === "glossary" && (
        <Glossary
          lead={lead}
          onFlag={async (id) => {
            await addPriorityTerm(id, "flagged by lead");
            queryClient.invalidateQueries({ queryKey: ["priorityTerms"] });
          }}
        />
      )}
    </div>
  );
}

function Daily({
  profileId,
  progress,
  priorityIds,
  onDone,
}: {
  profileId?: string;
  progress: { term_id: string; box: number; due: string }[];
  priorityIds: string[];
  onDone: () => void;
}) {
  const deck = useMemo(
    () => buildDeck(progress, priorityIds, 5),
    [progress, priorityIds],
  );
  const boxById = new Map(progress.map((p) => [p.term_id, p.box]));
  const [i, setI] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);

  if (deck.length === 0) {
    return <p className="muted">Daily 5 done ✓ — come back tomorrow, or take a quiz.</p>;
  }
  if (i >= deck.length) {
    return <p className="ok">Daily {done} done ✓ Nice work.</p>;
  }
  const term = deck[i];

  const grade = async (g: "again" | "got") => {
    if (profileId) await recordCard(profileId, term.id, boxById.get(term.id) ?? 0, g);
    setRevealed(false);
    setDone((d) => d + 1);
    setI((x) => x + 1);
    onDone();
  };

  return (
    <div>
      <p className="muted">Card {i + 1} of {deck.length} · which term is this?</p>
      <div className="detail-card" style={{ minHeight: 120 }}>
        <p>{term.desc}</p>
        {revealed && <p className="next-code" style={{ fontSize: 22 }}>{term.term}</p>}
      </div>
      {!revealed ? (
        <button className="primary big" onClick={() => setRevealed(true)}>Tap to reveal</button>
      ) : (
        <div className="grade-row">
          <button className="grade-btn" onClick={() => grade("again")}>Again</button>
          <button className="grade-btn selected" onClick={() => grade("got")}>Got it ✓</button>
        </div>
      )}
    </div>
  );
}

function Quiz({ profileId }: { profileId?: string }) {
  const [q, setQ] = useState(() => quizQuestion(TERMS[Math.floor(Math.random() * TERMS.length)]));
  const [n, setN] = useState(0);
  const [score, setScore] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [awarded, setAwarded] = useState(false);

  const answer = (id: string) => {
    setPicked(id);
    if (id === q.answer.id) setScore((s) => s + 1);
  };
  const next = () => {
    setPicked(null);
    setN((x) => x + 1);
    setQ(quizQuestion(TERMS[Math.floor(Math.random() * TERMS.length)]));
  };

  if (n >= 5) {
    // Write real points to the ledger once per completed round.
    if (!awarded && profileId && score > 0) {
      setAwarded(true);
      void awardPoints(
        profileId,
        [{ kind: "quiz", points: score * POINT_RULES.quizPerCorrect }],
        undefined,
        "confirmed",
      ).catch(() => {});
    }
    return (
      <div>
        <p className="next-code">{score}/5</p>
        <p className="ok">+{score * POINT_RULES.quizPerCorrect} points added.</p>
        <button className="primary big" onClick={() => { setN(0); setScore(0); setAwarded(false); next(); }}>Another round</button>
      </div>
    );
  }

  return (
    <div>
      <p className="muted">Question {n + 1} of 5 · which term is this?</p>
      <div className="detail-card"><p>{q.prompt}</p></div>
      <div className="action-list">
        {q.options.map((o) => {
          const cls =
            picked == null ? "action-btn"
            : o.id === q.answer.id ? "action-btn primary"
            : o.id === picked ? "action-btn" : "action-btn";
          return (
            <button key={o.id} className={cls} disabled={picked != null} onClick={() => answer(o.id)}>
              {o.term}
              {picked != null && o.id === q.answer.id ? " ✓" : ""}
            </button>
          );
        })}
      </div>
      {picked != null && (
        <button className="primary big" onClick={next}>Next</button>
      )}
    </div>
  );
}

function Sequence({ profileId }: { profileId?: string }) {
  const [branch, setBranch] = useState<"win" | "door">("win");
  const [q, setQ] = useState(() => nextStepQuestion(branch));
  const [n, setN] = useState(0);
  const [score, setScore] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [awarded, setAwarded] = useState(false);

  const pickBranch = (b: "win" | "door") => {
    setBranch(b);
    setN(0); setScore(0); setPicked(null); setAwarded(false);
    setQ(nextStepQuestion(b));
  };
  const answer = (id: string) => {
    setPicked(id);
    if (id === q.answer.id) setScore((s) => s + 1);
  };
  const next = () => {
    setPicked(null);
    setN((x) => x + 1);
    setQ(nextStepQuestion(branch));
  };

  return (
    <div>
      <div className="grade-row">
        <button className={branch === "win" ? "grade-btn selected" : "grade-btn"} onClick={() => pickBranch("win")}>Window</button>
        <button className={branch === "door" ? "grade-btn selected" : "grade-btn"} onClick={() => pickBranch("door")}>Door</button>
      </div>
      {n >= 5 ? (
        <div>
          <p className="next-code">{score}/5</p>
          {(() => {
            if (!awarded && profileId && score > 0) {
              setAwarded(true);
              void awardPoints(profileId, [{ kind: "quiz", points: score * POINT_RULES.quizPerCorrect }], undefined, "confirmed").catch(() => {});
            }
            return <p className="ok">+{score * POINT_RULES.quizPerCorrect} points added.</p>;
          })()}
          <button className="primary big" onClick={() => { setN(0); setScore(0); setAwarded(false); next(); }}>Another round</button>
        </div>
      ) : (
        <div>
          <p className="muted">Step {n + 1} of 5 · what comes right after this?</p>
          <div className="detail-card">
            <p className="next-label">STEP {q.current.step}</p>
            <strong>{q.current.label}</strong>
            <p className="muted" style={{ margin: "4px 0 0" }}>{q.current.desc}</p>
          </div>
          <div className="action-list">
            {q.options.map((o: ProcStep) => (
              <button
                key={o.id}
                className="action-btn"
                disabled={picked != null}
                onClick={() => answer(o.id)}
              >
                {o.label}
                {picked != null && o.id === q.answer.id ? " ✓" : ""}
              </button>
            ))}
          </div>
          {picked != null && <button className="primary big" onClick={next}>Next</button>}
        </div>
      )}
    </div>
  );
}

function Glossary({ lead, onFlag }: { lead: boolean; onFlag: (id: string) => void }) {
  const [cat, setCat] = useState(CATS[0].id);
  const [focusId, setFocusId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(TERMS.map((t) => [t.id, t])), []);
  const focus = focusId ? byId.get(focusId) : null;

  if (focus) {
    return (
      <div>
        <button className="link" onClick={() => setFocusId(null)}>← Back to glossary</button>
        <div className="detail-card">
          <strong style={{ fontSize: 18 }}>{focus.term}</strong>
          <p style={{ margin: "6px 0 0" }}>{focus.desc}</p>
        </div>
        {focus.links && focus.links.length > 0 && (
          <>
            <p className="field-label">Related</p>
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
              {focus.links.map((l) => {
                const lt = byId.get(l);
                if (!lt) return null;
                return (
                  <button key={l} className="button-like" onClick={() => setFocusId(l)}>
                    {lt.term}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {lead && (
          <button className="link" style={{ marginTop: 12 }} onClick={() => onFlag(focus.id)}>
            Push to crew decks (callback root cause)
          </button>
        )}
      </div>
    );
  }

  const terms = TERMS.filter((t) => t.cat === cat);
  return (
    <div>
      <select value={cat} onChange={(e) => setCat(e.target.value)}>
        {CATS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      <ul className="unit-list">
        {terms.map((t: Term) => (
          <li key={t.id}>
            <button className="link" onClick={() => setFocusId(t.id)} style={{ padding: 0, font: "inherit" }}>
              <strong>{t.term}</strong>
            </button>
            <p className="muted" style={{ margin: "4px 0 0" }}>{t.desc}</p>
            {lead && (
              <button className="link" onClick={() => onFlag(t.id)}>
                Push to crew decks (callback root cause)
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
