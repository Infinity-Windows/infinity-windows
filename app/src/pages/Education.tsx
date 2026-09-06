import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getMyProfile } from "../lib/install/api";
import { isForemanPlus, isSupervisorPlus } from "../lib/install/types";
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
  awardEducationQuiz,
  educationTermKey,
  EDUCATION_SEQUENCE_KEY,
  getEducationProgress,
  listMyProgress,
  listPriorityTerms,
  recordCard,
  type EducationProgress,
  type EducationQuizItem,
  type EducationQuizResult,
} from "../lib/learn";
import { formatApiError } from "../lib/errors";
import { useT, type TFn } from "../lib/i18n";
import { SendRecordingButton } from "../components/learn/SendRecordingButton";
import { VideoLibrary } from "../components/learn/VideoLibrary";

type Tab = "daily" | "quiz" | "sequence" | "glossary" | "videos";

export function Education() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const lead = isForemanPlus(me.data?.role);
  const progress = useQuery({
    queryKey: ["learnProgress", me.data?.id],
    queryFn: () => listMyProgress(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  const priority = useQuery({ queryKey: ["priorityTerms"], queryFn: listPriorityTerms });

  // The Learn tab's own standing, read off the server's two tables so the line
  // a person sees and the number they are paid against cannot drift apart.
  const eduProgress = useQuery({
    queryKey: ["educationProgress"],
    queryFn: getEducationProgress,
  });

  const [tab, setTab] = useState<Tab>("daily");

  const score = knowledgeScore(progress.data ?? []);
  const mastered = (progress.data ?? []).filter((p) => p.box >= 3).length;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Learn</h1>
          <p className="muted" style={{ margin: 0 }}>Learn it before you install it.</p>
        </div>
        <div className="learn-header-meta">
          <span className="streak-pill">{mastered} mastered</span>
          <Link to="/" className="button-like">Home</Link>
        </div>
      </header>

      <div className="stat-grid">
        <div className="stat-card accent">
          <span className="stat-num">{score}</span>
          <span>knowledge score</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{TERMS.length}</span>
          <span>terms</span>
        </div>
      </div>

      {/* Wave U, U2: the way a recording actually reaches this library — the
          installer mails the clip to their lead. Above the tabs because it has
          nothing to do with which tab is open, and because the person reaching
          for it has a video in their camera roll right now. */}
      <SendRecordingButton style={{ marginTop: 4 }} />

      <nav className="hub-tabs">
        {(["daily", "quiz", "sequence", "glossary", "videos"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "hub-tab active" : "hub-tab"} onClick={() => setTab(t)}>
            {t === "daily" ? "Daily 5" : t === "quiz" ? "Quiz" : t === "sequence" ? "Sequence" : t === "glossary" ? "Glossary" : "Videos"}
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
      {(tab === "quiz" || tab === "sequence") && (
        <EarnedLine progress={eduProgress.data} />
      )}
      {tab === "quiz" && <Quiz />}
      {tab === "sequence" && <Sequence />}
      {tab === "videos" && (
        <VideoLibrary canAuthor={isSupervisorPlus(me.data?.role)} />
      )}

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
      <div className="detail-card learn-card">
        <p className="next-label">Tap when you know it</p>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55 }}>{term.desc}</p>
        {revealed && <p className="next-code" style={{ margin: 0 }}>{term.term}</p>}
      </div>
      {!revealed ? (
        <button className="primary big" onClick={() => setRevealed(true)}>Tap to reveal</button>
      ) : (
        <div className="grade-row">
          <button className="grade-btn again" onClick={() => grade("again")}>Again</button>
          <button className="grade-btn got" onClick={() => grade("got")}>Got it ✓</button>
        </div>
      )}
    </div>
  );
}

/**
 * The line above both quizzes: how much of the glossary this person has
 * actually earned, and why another round of the same terms pays nothing.
 *
 * It is deliberately not a scold. Practising is free and unlimited; the number
 * is there so somebody who wants points can see where the new ground is.
 */
function EarnedLine({ progress }: { progress?: EducationProgress }) {
  const t = useT();
  if (!progress) return null;
  return (
    <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
      {t("learn.points.progress", {
        earned: progress.termsEarned,
        total: progress.termsTotal,
      })}
      {" · "}
      {t("learn.points.newContentOnly")}
    </p>
  );
}

/**
 * The glossary quiz: five random terms, four options each.
 *
 * WHAT CHANGED 2026-09-05. This used to write its own points into the ledger
 * after every round — score x 10, straight from the browser, with no record of
 * which terms it asked — and offer "Another round" underneath. So the same five
 * terms paid again on every tap, hundreds of times over in a single day between
 * two profiles. Now the round reports WHAT IT ASKED and how it went, and the server
 * prices it: a term pays the first time it is answered correctly and never
 * again. The round itself is untouched, because the practice was never the
 * problem.
 */
function Quiz() {
  const t = useT();
  const queryClient = useQueryClient();
  const [q, setQ] = useState(() => quizQuestion(TERMS[Math.floor(Math.random() * TERMS.length)]));
  const [n, setN] = useState(0);
  const [score, setScore] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  /** The round, as asked. This is the payload; the total is the server's. */
  const [asked, setAsked] = useState<EducationQuizItem[]>([]);
  const [filed, setFiled] = useState(false);
  const [result, setResult] = useState<EducationQuizResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const answer = (id: string) => {
    setPicked(id);
    const correct = id === q.answer.id;
    if (correct) setScore((s) => s + 1);
    setAsked((a) => [...a, { key: educationTermKey(q.answer.id), correct }]);
  };
  const next = () => {
    setPicked(null);
    setN((x) => x + 1);
    setQ(quizQuestion(TERMS[Math.floor(Math.random() * TERMS.length)]));
  };
  // Question 1, not question 2. The old "Another round" reset n to 0 and then
  // called next(), which added one back — every round after the first was four
  // questions wearing a five-question label.
  const anotherRound = () => {
    setPicked(null);
    setN(0);
    setScore(0);
    setAsked([]);
    setFiled(false);
    setResult(null);
    setFailed(null);
    setQ(quizQuestion(TERMS[Math.floor(Math.random() * TERMS.length)]));
  };

  // Filed once, after the fifth answer, from an effect rather than mid-render —
  // the old code kicked the award off inside the render body and guarded it
  // with a flag it set in the same breath.
  useEffect(() => {
    if (n < 5 || filed) return;
    setFiled(true);
    void awardEducationQuiz(asked)
      .then((r) => {
        setResult(r);
        queryClient.invalidateQueries({ queryKey: ["educationProgress"] });
        queryClient.invalidateQueries({ queryKey: ["ledger"] });
        queryClient.invalidateQueries({ queryKey: ["pointsLeaderboard"] });
      })
      .catch((err) => setFailed(formatApiError(err)));
  }, [n, filed, asked, queryClient]);

  if (n >= 5) {
    return (
      <div className="quiz-done">
        <p className="next-code" style={{ margin: 0 }}>{score}/5</p>
        <RoundOutcome result={result} failed={failed} t={t} />
        <button className="primary big" onClick={anotherRound}>
          {t("learn.points.anotherRound")}
        </button>
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

/** What a finished glossary round earned, in one line. */
function RoundOutcome({
  result,
  failed,
  t,
}: {
  result: EducationQuizResult | null;
  failed: string | null;
  t: TFn;
}) {
  if (failed) return <p className="warn">{t("learn.points.failed", { reason: failed })}</p>;
  if (result == null) return <p className="muted">{t("learn.points.saving")}</p>;
  if (result.newTerms === 1) {
    return <p className="ok">{t("learn.points.newOne", { points: result.pointsAwarded })}</p>;
  }
  if (result.newTerms > 1) {
    return (
      <p className="ok">
        {t("learn.points.newMany", {
          points: result.pointsAwarded,
          count: result.newTerms,
        })}
      </p>
    );
  }
  return <p className="muted">{t("learn.points.none")}</p>;
}

/**
 * The install-sequence game: five "what comes right after this?" steps.
 *
 * The whole quiz is ONE earnable item, not one per step — it is a single
 * procedure, and knowing it is a single thing to know. The bar is 4 of 5, the
 * same bar a video quiz passes at (20260962000000), and it pays once.
 */
function Sequence() {
  const t = useT();
  const queryClient = useQueryClient();
  const [branch, setBranch] = useState<"win" | "door">("win");
  const [q, setQ] = useState(() => nextStepQuestion(branch));
  const [n, setN] = useState(0);
  const [score, setScore] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [filed, setFiled] = useState(false);
  const [result, setResult] = useState<EducationQuizResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const restart = (b: "win" | "door") => {
    setBranch(b);
    setPicked(null);
    setN(0);
    setScore(0);
    setFiled(false);
    setResult(null);
    setFailed(null);
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

  const passed = score >= 4;
  useEffect(() => {
    if (n < 5 || filed) return;
    setFiled(true);
    void awardEducationQuiz([{ key: EDUCATION_SEQUENCE_KEY, correct: passed }])
      .then((r) => {
        setResult(r);
        queryClient.invalidateQueries({ queryKey: ["educationProgress"] });
        queryClient.invalidateQueries({ queryKey: ["ledger"] });
        queryClient.invalidateQueries({ queryKey: ["pointsLeaderboard"] });
      })
      .catch((err) => setFailed(formatApiError(err)));
  }, [n, filed, passed, queryClient]);

  return (
    <div>
      <div className="grade-row">
        <button className={branch === "win" ? "grade-btn selected" : "grade-btn"} onClick={() => restart("win")}>Window</button>
        <button className={branch === "door" ? "grade-btn selected" : "grade-btn"} onClick={() => restart("door")}>Door</button>
      </div>
      {n >= 5 ? (
        <div>
          <p className="next-code">{score}/5</p>
          <SequenceOutcome result={result} failed={failed} passed={passed} t={t} />
          <button className="primary big" onClick={() => restart(branch)}>
            {t("learn.points.anotherRound")}
          </button>
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

/** What a finished sequence round earned — including the "not this time" case,
 * which needs to say what the bar is rather than just "no points". */
function SequenceOutcome({
  result,
  failed,
  passed,
  t,
}: {
  result: EducationQuizResult | null;
  failed: string | null;
  passed: boolean;
  t: TFn;
}) {
  if (failed) return <p className="warn">{t("learn.points.failed", { reason: failed })}</p>;
  if (result == null) return <p className="muted">{t("learn.points.saving")}</p>;
  if (result.newTerms > 0) {
    return <p className="ok">{t("learn.points.sequenceEarned", { points: result.pointsAwarded })}</p>;
  }
  if (passed) return <p className="muted">{t("learn.points.sequenceHad")}</p>;
  return <p className="muted">{t("learn.points.sequenceBar")}</p>;
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
