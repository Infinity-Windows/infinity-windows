import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  generateHowto,
  getTypeBrainStats,
  synthesizeTypeTips,
  updateTypeKnowledge,
} from "../../lib/install/api";
import { formatApiError } from "../../lib/install/errors";
import { MEMO_TOPICS, isForemanPlus } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import type { HowtoStep } from "../../lib/types";

export function TypeBrainCard() {
  const { typeId = "" } = useParams();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [tipsText, setTipsText] = useState("");
  const [watchText, setWatchText] = useState("");
  const stats = useQuery({
    queryKey: ["typeBrain", typeId],
    queryFn: () => getTypeBrainStats(typeId),
  });
  // Gate the Edit affordance on the effective (view-as aware) role so an owner
  // previewing "installer" faithfully sees the read-only card. Server mutations
  // still run as the real signed-in user.
  const { effectiveRole } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);

  const refetch = () =>
    queryClient.invalidateQueries({ queryKey: ["typeBrain", typeId] });

  const synthesize = useMutation({
    mutationFn: () => synthesizeTypeTips(typeId),
    onSuccess: refetch,
  });

  const howto = useMutation({
    mutationFn: () => generateHowto(typeId),
    onSuccess: refetch,
  });

  const saveEdits = useMutation({
    mutationFn: () =>
      updateTypeKnowledge(typeId, {
        tips_json: tipsText.split("\n").map((l) => l.trim()).filter(Boolean),
        watch_outs_json: watchText.split("\n").map((l) => l.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      setEditing(false);
      refetch();
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
        <div>
          <p className="home-greeting">Type brain</p>
          <h1>{s.type.type_code}</h1>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">
          ‹
        </Link>
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
        <div
          className="stat-card"
          title="9 out of 10 installs of this type finish faster than this"
        >
          <span className="stat-num">
            {s.p90Minutes !== null ? `${Math.round(s.p90Minutes)}m` : "—"}
          </span>
          <span>slow-case time</span>
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

      <div className="row-between">
        <h2>Top tips</h2>
        {isLead && !editing && (
          <button
            className="link"
            onClick={() => {
              setTipsText(s.tips.join("\n"));
              setWatchText(s.watchOuts.join("\n"));
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <>
          <label className="field-label">Tips (one per line)</label>
          <textarea
            className="knowledge-edit"
            value={tipsText}
            onChange={(e) => setTipsText(e.target.value)}
          />
          <label className="field-label">Watch-outs (one per line)</label>
          <textarea
            className="knowledge-edit"
            value={watchText}
            onChange={(e) => setWatchText(e.target.value)}
          />
          <div className="row-gap">
            <button
              className="primary"
              disabled={saveEdits.isPending}
              onClick={() => saveEdits.mutate()}
            >
              Save
            </button>
            <button className="button-like" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : s.tips.length === 0 ? (
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

      {!editing && s.watchOuts.length > 0 && (
        <>
          <h2>Watch-outs</h2>
          <ul className="tip-list watch">
            {s.watchOuts.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      )}

      {/* --- How-to guide --- */}
      {(s.type.howto_json?.length ?? 0) > 0 && (
        <>
          <h2>How to install</h2>
          <ol className="howto-list">
            {(s.type.howto_json as HowtoStep[]).map((step, i) => (
              <li key={i}>
                <strong>{step.title}</strong>
                {step.detail ? <div className="muted">{step.detail}</div> : null}
              </li>
            ))}
          </ol>
        </>
      )}

      <div className="row-gap">
        <button
          disabled={!canSynthesize || synthesize.isPending}
          onClick={() => synthesize.mutate()}
        >
          {synthesize.isPending
            ? "Synthesizing…"
            : canSynthesize
              ? "Re-synthesize tips"
              : `Need ${3 - s.installCount} more install(s)`}
        </button>
        <button
          disabled={howto.isPending || !s.type.golden_install_event_id}
          onClick={() => howto.mutate()}
        >
          {howto.isPending
            ? "Writing how-to…"
            : s.type.howto_json?.length
              ? "Refresh how-to"
              : "Generate how-to"}
        </button>
      </div>
      {(synthesize.isError || howto.isError) && (
        <p className="error">{formatApiError(synthesize.error ?? howto.error)}</p>
      )}

      {(s.videos.length > 0 || s.type.tutorial_url) && (
        <>
          <h2>Golden video</h2>
          {s.videos[0]?.signedUrl ? (
            <video controls src={s.videos[0].signedUrl} className="golden-video" />
          ) : s.type.tutorial_url ? (
            <p>
              <a href={s.type.tutorial_url} className="suggest">
                Tutorial video →
              </a>
            </p>
          ) : null}
        </>
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
