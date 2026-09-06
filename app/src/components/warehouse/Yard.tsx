// The yard: every box drawn as a box (warehouse redesign wave 3). The
// building is first and widest, a conex shows its door end, crates ride
// inside the box that holds them, and a job stripe says whose material is
// where before any words do. A lit box is where Find's answer sits.
import { Link } from "react-router-dom";
import type { YardTile } from "../../lib/warehouse/yard";

function tileLine(t: YardTile): string {
  // Same words the old container tiles used, so "1 package · BLACK22 ×1"
  // still reads the same on the page (and in the tests that pin it).
  const jobs = t.jobs.slice(0, 3).map((j) => `${j.jobCode} ×${j.count}`).join(", ");
  let line = `${t.inside} package${t.inside === 1 ? "" : "s"}`;
  if (t.inside > 0 && jobs) line += ` · ${jobs}`;
  if (t.children.length > 0) line += ` · holding ${t.children.length} crate${t.children.length === 1 ? "" : "s"}`;
  if (t.oldestDays > 0) line += ` · oldest ${t.oldestDays}d`;
  return line;
}

export function Yard({ tiles, onAdd }: { tiles: YardTile[]; onAdd: () => void }) {
  return (
    <div className="yard" role="list" aria-label="The yard">
      {tiles.map((t) => (
        <Link
          key={t.id}
          to={`/storage/c/${t.id}`}
          role="listitem"
          className={`yard-box yard-box--${t.kind}${t.glow ? " yard-box--glow" : ""}${t.kind === "building" ? " yard-box--wide" : ""}`}
          data-testid="yard-box"
        >
          {t.kind === "conex" || t.kind === "truck" || t.kind === "trailer" ? (
            <span className="yard-door" aria-hidden="true" />
          ) : null}
          <span className="yard-name">{t.name}</span>
          <span className="yard-kind">{t.kind === "conex" ? "" : t.kind}</span>
          <span className="yard-line">{tileLine(t)}</span>
          {t.inside > 0 ? (
            <span className="yard-stripe" aria-hidden="true">
              {t.jobs.map((j) => (
                <i
                  key={j.projectId ?? "boneyard"}
                  style={{ flex: j.count, background: `oklch(0.62 0.15 ${j.hue})` }}
                  title={`${j.jobCode} ×${j.count}`}
                />
              ))}
            </span>
          ) : (
            <span className="yard-stripe yard-stripe--empty" aria-hidden="true" />
          )}
          {t.children.length > 0 ? (
            <span className="yard-crates">
              {t.children.map((c) => (
                <span key={c.id} className={`yard-crate${c.glow ? " yard-crate--glow" : ""}`}>
                  {c.name} · {c.inside}
                </span>
              ))}
            </span>
          ) : null}
        </Link>
      ))}
      <button type="button" className="yard-box yard-box--add" onClick={onAdd}>
        <span className="yard-name">+ New container</span>
        <span className="yard-line">a conex, crate or truck</span>
      </button>
    </div>
  );
}
