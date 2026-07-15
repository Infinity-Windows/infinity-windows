import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { getTypeBrainStats } from "../../lib/install/api";
import { MEMO_TOPICS } from "../../lib/install/types";

export function TypeBrainCard() {
  const { typeId = "" } = useParams();
  const stats = useQuery({
    queryKey: ["typeBrain", typeId],
    queryFn: () => getTypeBrainStats(typeId),
  });

  if (stats.isLoading) {
    return <div className="page"><p className="muted">Loading…</p></div>;
  }
  const s = stats.data;
  if (!s?.type) {
    return <div className="page"><p className="error">Unknown window type.</p></div>;
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>{s.type.type_code}</h1>
      </header>
      <p className="muted">{s.type.name}</p>

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-num">{s.installCount}</span>
          <span>installs recorded</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">
            {s.medianMinutes !== null ? `${s.medianMinutes}m` : "—"}
          </span>
          <span>median install time</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{s.avgGrade ?? "—"}</span>
          <span>avg quality (1–5)</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{s.type.difficulty_rating ?? "—"}</span>
          <span>catalog difficulty</span>
        </div>
      </div>

      {s.type.notes && (
        <div className="detail-card">
          <p>{s.type.notes}</p>
        </div>
      )}

      <h2>Recent install notes</h2>
      {s.recent.length === 0 && (
        <p className="muted">
          No installs captured yet for this type. Every memo the crew records
          lands here.
        </p>
      )}
      <ul className="unit-list">
        {s.recent.map((e) => (
          <li key={e.id}>
            <p className="muted" style={{ margin: 0 }}>
              {e.created_at.slice(0, 10)}
              {e.installer ? ` — ${e.installer}` : ""}
              {e.minutes !== null ? ` — ${e.minutes}m` : ""}
              {e.quality_grade !== null ? ` — grade ${e.quality_grade}` : ""}
            </p>
            {MEMO_TOPICS.map((t) =>
              e[t.key] ? (
                <p key={t.key} style={{ margin: "4px 0" }}>
                  <span className="muted">{t.prompt}:</span> {e[t.key]}
                </p>
              ) : null,
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
