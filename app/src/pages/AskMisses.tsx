import { BackChip } from "../components/BackChip";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  groupAskLog,
  listAskedQuestions,
  markAskedQuestionReviewed,
} from "../lib/brain/askLog";

/**
 * What the crew asked that we had no answer for.
 *
 * This is the list that tells a foreman exactly what to write next, in the
 * crew's own words rather than from guesswork — the highest-value item in
 * docs/ask-infinity-token-free.md. Foreman and above only; the RLS policy on
 * ask_question_log enforces that server-side too.
 */
export function AskMisses() {
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);

  const log = useQuery({
    queryKey: ["askQuestionLog", showAll],
    queryFn: () => listAskedQuestions({ onlyUnanswered: !showAll }),
  });

  const review = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await markAskedQuestionReviewed(id);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["askQuestionLog"] }),
  });

  const groups = useMemo(() => groupAskLog(log.data ?? []), [log.data]);
  const open = groups.filter((g) => !g.reviewed);
  const done = groups.filter((g) => g.reviewed);
  const totalAsks = (log.data ?? []).length;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>What crew asked</h1>
          <p className="muted" style={{ margin: 0 }}>
            {showAll
              ? "Every question asked of the company brain."
              : "Questions our own notes could not answer."}
          </p>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>

      <div className="row-gap" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className={showAll ? "chip" : "chip selected"}
          onClick={() => setShowAll(false)}
        >
          Unanswered
        </button>
        <button
          type="button"
          className={showAll ? "chip selected" : "chip"}
          onClick={() => setShowAll(true)}
        >
          Everything
        </button>
      </div>

      {log.isLoading && <p className="muted">Loading…</p>}
      {log.isError && (
        <p className="muted">
          Can't read the log. It may not be set up yet, or your role can't see it.
        </p>
      )}

      {!log.isLoading && !log.isError && groups.length === 0 && (
        <div className="detail-card">
          <p style={{ margin: 0 }}>
            Nothing logged yet. Every question crew ask lands here, so this fills up on its own.
          </p>
        </div>
      )}

      {open.length > 0 && (
        <>
          <h2>
            To write ({open.length} question{open.length === 1 ? "" : "s"}, {totalAsks} asks)
          </h2>
          <p className="muted">
            Add the answer as an install tip on the window type, or as a glossary term, then mark
            it written. It reaches every phone with the next refresh.
          </p>
          <ul className="unit-list work-list">
            {open.map((g) => (
              <li key={g.ids[0]} className="find-row" style={{ flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{g.question}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>
                    asked {g.asks}×· last {new Date(g.lastAskedAt).toLocaleDateString()}
                  </div>
                  {g.matchedTitles.length > 0 && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      We showed: {g.matchedTitles.join(", ")}
                    </div>
                  )}
                </div>
                <button
                  className="button-like qc-pass"
                  style={{ marginLeft: "auto" }}
                  disabled={review.isPending}
                  onClick={() => review.mutate(g.ids)}
                >
                  Written ✓
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {done.length > 0 && (
        <>
          <h2>Already handled</h2>
          <ul className="unit-list work-list">
            {done.slice(0, 30).map((g) => (
              <li key={g.ids[0]} className="find-row">
                <span>{g.question}</span>
                <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                  {g.asks}×
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
