import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { getTypeBrainStats, synthesizeTypeTips } from "../../lib/install/api";
import { MEMO_TOPICS } from "../../lib/install/types";

export function TypeBrainCard() {
  const { typeId = "" } = useParams();
  const queryClient = useQueryClient();
  const stats = useQuery({
    queryKey: ["typeBrain", typeId],
    queryFn: () => getTypeBrainStats(typeId),
  });

  const synthesize = useMutation({
    mutationFn: () => synthesizeTypeTips(typeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["typeBrain", typeId] });
    },
  });

  if (stats.isLoading) {
    return (
      <div className="page">
        <p className="muted">Loading…</p>
      </div>
    );
  }
  const s = stats.data;
  if (!s?.type) {
    return (
      <div className="page">
        <p className="error">Unknown window type.</p>
      </div>
    );
  }

  const difficulty = s.outcomeDifficulty ?? s.type.difficulty_rating;
  const canSynthesize = s.installCount >= 3;

  return (
    <div className="page">
      <header className="page-header">
        <h1>{s.type.type_code}</h1>
        <button type="button" className="button-like" onClick={() => history.back()}>
          Back
        </button>
      </header>
      <p className="muted">{s.type.name}</p>
      <p className="brain-tagline">
        Time target, difficulty, tips — learned from real installs.
      </p>

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-num">
            {s.medianMinutes !== null ? `${Math.round(s.medianMinutes)}m` : "—"}
          </span>
          <span>median time</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">
            {s.p90Minutes !== null ? `${Math.round(s.p90Minutes)}m` : "—"}
          </span>
          <span>P90 time</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">
            {difficulty !== null && difficulty !== undefined
              ? "★".repeat(difficulty)
              : "—"}
          </span>
          <span>outcome difficulty</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">
            {s.failRate !== null ? `${s.failRate}%` : "—"}
          </span>
          <span>fail rate (grade ≤2)</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{s.installCount}</span>
          <span>installs recorded</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{s.avgGrade ?? "—"}</span>
          <span>avg quality (1–5)</span>
        </div>
      </div>

      <h2>Top tips</h2>
      {s.tips.length === 0 ? (
        <p className="muted">
          Tips appear after ~3 installs with memos. Hit synthesize below once
          you have enough.
        </p>
      ) : (
        <ol className="tip-list">
          {s.tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ol>
      )}

      {s.watchOuts.length > 0 && (
        <>
          <h2>Watch-outs</h2>
          <ul className="tip-list watch">
            {s.watchOuts.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      )}

      <button
        className="primary big"
        disabled={!canSynthesize || synthesize.isPending}
        onClick={() => synthesize.mutate()}
      >
        {synthesize.isPending
          ? "Synthesizing…"
          : canSynthesize
            ? "Re-synthesize tips from installs"
            : `Need ${3 - s.installCount} more install(s) to synthesize`}
      </button>
      {synthesize.isError && <p className="error">{String(synthesize.error)}</p>}
      {synthesize.isSuccess && (
        <p className="ok">Tips updated from install memos.</p>
      )}

      {s.type.tutorial_url && (
        <p>
          <a href={s.type.tutorial_url} className="suggest">
            Tutorial video →
          </a>
        </p>
      )}

      {s.photos.length > 0 && (
        <>
          <h2>Install photos</h2>
          <div className="photo-grid">
            {s.photos.map((p) =>
              p.signedUrl ? (
                <a key={p.id} href={p.signedUrl} target="_blank" rel="noreferrer">
                  <img src={p.signedUrl} alt="Install" />
                </a>
              ) : null,
            )}
          </div>
        </>
      )}

      {s.voiceMemos.length > 0 && (
        <>
          <h2>Voice memos</h2>
          <ul className="unit-list">
            {s.voiceMemos.map((v) => (
              <li key={v.id}>
                <p className="muted" style={{ margin: "0 0 6px" }}>
                  {v.created_at.slice(0, 10)}
                </p>
                {v.signedUrl ? (
                  <audio controls src={v.signedUrl} className="audio-preview" />
                ) : (
                  <span className="muted">Playback unavailable</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

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
