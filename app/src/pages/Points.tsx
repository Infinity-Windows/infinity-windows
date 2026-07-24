import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getMyProfile } from "../lib/install/api";
import {
  getPointsLeaderboard,
  listLedger,
  pointsByCategory,
  POINT_RULES,
} from "../lib/points";

const KIND_LABELS: Record<string, string> = {
  install: "Install",
  par: "Beat par time",
  photos: "Proof photos",
  teach: "Taught the crew",
  quality: "Quality (QC grade)",
  quiz: "Quiz",
};

/** Soft local tiers for the progress bar — look only, no RPC. */
const TIERS = [
  { label: "Starter", at: 0 },
  { label: "Crew", at: 200 },
  { label: "Pro", at: 500 },
  { label: "Lead hand", at: 1000 },
  { label: "Ace", at: 2000 },
];

function tierFor(total: number) {
  let current = TIERS[0];
  let next = TIERS[1];
  for (let i = 0; i < TIERS.length; i++) {
    if (total >= TIERS[i].at) {
      current = TIERS[i];
      next = TIERS[i + 1] ?? null;
    }
  }
  const floor = current.at;
  const ceiling = next?.at ?? floor + 500;
  const pct = next
    ? Math.min(100, Math.round(((total - floor) / (ceiling - floor)) * 100))
    : 100;
  return {
    label: current.label,
    nextLabel: next ? `${next.label} · ${ceiling}` : "Top tier",
    pct,
  };
}

export function Points() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const ledger = useQuery({
    queryKey: ["ledger", me.data?.id],
    queryFn: () => listLedger(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  const board = useQuery({ queryKey: ["pointsLeaderboard"], queryFn: getPointsLeaderboard });

  const rows = ledger.data ?? [];
  const confirmed = rows.filter((r) => r.status === "confirmed");
  const total = confirmed.reduce((s, r) => s + r.points, 0);
  const pending = rows.filter((r) => r.status === "pending").reduce((s, r) => s + r.points, 0);
  const categories = pointsByCategory(rows);
  const tier = tierFor(total);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>My points</h1>
          <p className="muted" style={{ margin: 0 }}>
            Year to date · releases after QC
          </p>
        </div>
        <Link to="/" className="button-like">Home</Link>
      </header>

      <div className="points-hero">
        <div className="points-hero-top">
          <div className="points-total">{total}</div>
          <div className="points-total-label">total points</div>
        </div>
        <div className="points-tier-bar" aria-hidden>
          <div className="points-tier-fill" style={{ width: `${tier.pct}%` }} />
        </div>
        <div className="row-between" style={{ marginTop: 0 }}>
          <span className="muted" style={{ fontSize: 12 }}>{tier.label}</span>
          <span className="muted" style={{ fontSize: 12 }}>{tier.nextLabel}</span>
        </div>
        <div className="points-mini-grid">
          <div className="points-mini warn">
            <span>Pending QC</span>
            <strong>{pending}</strong>
          </div>
        </div>
      </div>

      <div className="points-rules">
        <strong style={{ fontSize: 14 }}>How points work</strong>
        <ul className="tip-list">
          <li>Install: +{POINT_RULES.installBase}</li>
          <li>Beat par time: +{POINT_RULES.parBeat}</li>
          <li>Proof photos: +{POINT_RULES.photos}</li>
          <li>Teach the crew (voice memo): +{POINT_RULES.teach}</li>
          <li>Quality grade 4+: +{POINT_RULES.quality}</li>
          <li>Quiz: +{POINT_RULES.quizPerCorrect}/correct</li>
        </ul>
      </div>

      <h2>Points by category</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        Raw confirmed subtotals — each category tracked separately.
      </p>
      <ul className="unit-list work-list">
        {categories.map(({ kind, points }) => (
          <li key={kind} className="find-row">
            <span>{KIND_LABELS[kind] ?? kind}</span>
            <span className="ledger-pts">+{points}</span>
          </li>
        ))}
      </ul>

      <h2>Team · this year</h2>
      <ul className="unit-list work-list">
        {(board.data ?? []).map((r, i) => (
          <li key={r.profile_id} className="find-row">
            <span>
              <strong>{i + 1}.</strong> {r.display_name}
            </span>
            <span className="ledger-pts" style={{ color: "var(--text)" }}>
              {r.points}
            </span>
          </li>
        ))}
        {board.data?.length === 0 && (
          <p className="muted">No points logged yet.</p>
        )}
      </ul>
    </div>
  );
}
