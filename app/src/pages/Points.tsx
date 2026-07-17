import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getMyProfile } from "../lib/install/api";
import {
  getPointsLeaderboard,
  listLedger,
  POINT_RULES,
} from "../lib/points";

const KIND_LABELS: Record<string, string> = {
  install: "Install",
  par: "Beat par time",
  photos: "Proof photos",
  teach: "Taught the crew",
  quality: "Quality grade",
  quiz: "Quiz",
};

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
  const byKind = new Map<string, number>();
  for (const r of confirmed) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + r.points);

  return (
    <div className="page">
      <header className="page-header">
        <h1>My points</h1>
        <Link to="/" className="button-like">Home</Link>
      </header>

      <div className="stat-grid">
        <div className="stat-card"><span className="stat-num">{total}</span><span>points · YTD</span></div>
        <div className="stat-card"><span className="stat-num">{pending}</span><span>pending QC</span></div>
        <div className="stat-card"><span className="stat-num">${Math.round(total * 0.25)}</span><span>est. bonus value</span></div>
      </div>

      <h2>How points work</h2>
      <ul className="tip-list">
        <li>Install: +{POINT_RULES.installBase}</li>
        <li>Beat par time: +{POINT_RULES.parBeat}</li>
        <li>Proof photos: +{POINT_RULES.photos}</li>
        <li>Teach the crew (voice memo): +{POINT_RULES.teach}</li>
        <li>Quality grade 4+: +{POINT_RULES.quality}</li>
        <li>Quiz: +{POINT_RULES.quizPerCorrect}/correct</li>
      </ul>

      <h2>My ledger</h2>
      <ul className="unit-list">
        {[...byKind.entries()].map(([k, p]) => (
          <li key={k} className="find-row">
            <span>{KIND_LABELS[k] ?? k}</span>
            <span style={{ marginLeft: "auto" }} className="ok">+{p}</span>
          </li>
        ))}
        {rows.length === 0 && <p className="muted">No points yet — install a window to start.</p>}
      </ul>

      <h2>Team · this year</h2>
      <table className="analytics-table">
        <thead><tr><th>Installer</th><th className="num">Points</th></tr></thead>
        <tbody>
          {(board.data ?? []).map((r, i) => (
            <tr key={r.profile_id}>
              <td>{i + 1}. {r.display_name}</td>
              <td className="num">{r.points}</td>
            </tr>
          ))}
          {board.data?.length === 0 && <tr><td colSpan={2} className="muted">No points logged yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
