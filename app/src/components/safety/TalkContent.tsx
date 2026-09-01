// The talk reading surface, shared by the Safety page and the clock sheet's
// compact sign card. Library talks get Horizon's tiered layout; AI-generated
// and legacy talks keep their sections/body render.

import { TALK_CATEGORY_LABELS, type SafetyTalk } from "../../lib/ops";

/**
 * A library talk renders Horizon's tiered layout: briefing paragraphs,
 * orange key points, an amber "Watch for" callout, and a red "Stop work"
 * callout. AI-generated and legacy talks keep their sections/body render.
 */
export function TalkContent({ talk }: { talk: SafetyTalk }) {
  if (talk.key_points?.length) {
    return (
      <div>
        {talk.category && (
          <span className={`tbx-cat ${talk.category}`}>
            {TALK_CATEGORY_LABELS[talk.category] ?? talk.category}
          </span>
        )}
        {talk.citation && (
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 11 }}>
            Source: {talk.citation} — Forge Windows safety brief inspired by OSHA
            topics, not an official OSHA publication.
          </p>
        )}
        {(talk.body.split("\n\nKey points:")[0] ?? talk.body)
          .split("\n\n")
          .map((p, i) => (
            <p key={i} style={{ margin: "8px 0 0", lineHeight: 1.6 }}>{p}</p>
          ))}
        <div className="talk-section">
          <h4>Key points</h4>
          <ul className="talk-list tbx-points">
            {talk.key_points.map((k, i) => <li key={i}>{k}</li>)}
          </ul>
        </div>
        {!!talk.watch_for?.length && (
          <div className="tbx-callout warn">
            <h4>Watch for</h4>
            <ul className="talk-list">
              {talk.watch_for.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
        {talk.stop_work_line && (
          <div className="tbx-callout stop">
            <h4>Stop work</h4>
            <p style={{ margin: 0 }}>{talk.stop_work_line}</p>
          </div>
        )}
      </div>
    );
  }
  const s = talk.sections_json ?? null;
  const aids = talk.visual_aids_json ?? [];
  if (!s || (!s.intro && !s.key_hazards?.length && !s.steps?.length)) {
    return <p className="muted" style={{ margin: 0, lineHeight: 1.65 }}>{talk.body}</p>;
  }
  return (
    <div>
      {s.intro && <p style={{ margin: "0 0 6px", lineHeight: 1.6 }}>{s.intro}</p>}
      {!!s.key_hazards?.length && (
        <div className="talk-section hazards">
          <h4>Key hazards</h4>
          <ul className="talk-list">
            {s.key_hazards.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </div>
      )}
      {!!s.steps?.length && (
        <div className="talk-section">
          <h4>Step by step</h4>
          <ol className="talk-list talk-steps">
            {s.steps.map((st, i) => <li key={i}>{st}</li>)}
          </ol>
        </div>
      )}
      {(!!s.dos?.length || !!s.donts?.length) && (
        <div className="talk-section">
          <div className="dodont-grid">
            <div className="do">
              <h4 style={{ color: "var(--ok)" }}>Do</h4>
              <ul className="talk-list">
                {(s.dos ?? []).map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </div>
            <div className="dont">
              <h4 style={{ color: "var(--danger)" }}>Don't</h4>
              <ul className="talk-list">
                {(s.donts ?? []).map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </div>
          </div>
        </div>
      )}
      {!!aids.length && (
        <div className="talk-section">
          <h4>Visual aids</h4>
          <div className="talk-aids">
            {aids.map((a, i) =>
              a.url ? (
                <figure key={i} className="talk-aid">
                  <img src={a.url} alt={a.prompt} />
                  <figcaption className="aid-caption">{a.prompt}</figcaption>
                </figure>
              ) : (
                <div key={i} className="talk-aid placeholder">
                  <strong>Diagram:</strong> {a.prompt}
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
