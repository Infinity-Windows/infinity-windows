// "How does tracking work?" — the package map, drawn from packageFlow.ts.
//
// This component holds no facts. Every box, arrow, coordinate and sentence
// comes from lib/warehouse/packageFlow.ts, which is unit-tested; all this file
// does is draw them and handle the lighting-up. If something here looks wrong,
// the fix is in the data.
//
// Touch first: hovering does not exist on a phone, so tapping a step pins it
// and tapping it again (or Esc, or the Clear button) releases. Hover is a
// desktop nicety layered on top, never the only way in.

import { useCallback, useState } from "react";
import {
  CONTAINERS,
  EDGES,
  FLOW_ALT,
  FLOW_VIEWBOX,
  NODES,
  flowNode,
  type EdgeId,
  type NodeId,
} from "../../lib/warehouse/packageFlow";

export function PackageMap() {
  const [pinned, setPinned] = useState<NodeId | null>(null);
  const [hovered, setHovered] = useState<NodeId | null>(null);
  const active = pinned ?? hovered;
  const detail = active ? flowNode(active) : undefined;

  const lit = new Set<NodeId>();
  const litEdges = new Set<EdgeId>();
  if (detail) {
    lit.add(detail.id);
    for (const r of detail.related) lit.add(r);
    for (const e of detail.edges) litEdges.add(e);
  }

  const toggle = useCallback((id: NodeId) => {
    setPinned((cur) => (cur === id ? null : id));
  }, []);

  return (
    <div className="pkgmap">
      <p className="pkgmap-lede">
        A window is not one thing you can pick up. Door <span className="pkgmap-code">#16</span>{" "}
        arrives as three packages — frame, glass, hardware — and each one travels on its own.{" "}
        <strong>The package is what carries a sticker and what moves; the window is just the list of its parts.</strong>
      </p>

      <div className="pkgmap-legend">
        <span>
          <svg width="30" height="9" aria-hidden="true">
            <line x1="0" y1="4.5" x2="22" y2="4.5" stroke="currentColor" strokeWidth="1.4" />
            <polygon points="22,1 30,4.5 22,8" fill="currentColor" />
          </svg>
          The normal path
        </span>
        <span>
          <svg width="30" height="9" aria-hidden="true">
            <line x1="0" y1="4.5" x2="22" y2="4.5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="5 4" />
            <polygon points="22,1 30,4.5 22,8" fill="currentColor" />
          </svg>
          Went sideways, or came back
        </span>
        <span className="pkgmap-hint">Tap a step to see how it works</span>
      </div>

      <div className="pkgmap-frame">
        <svg
          className={`pkgmap-svg${detail ? " is-dim" : ""}`}
          viewBox={`0 ${FLOW_VIEWBOX.minY} ${FLOW_VIEWBOX.w} ${FLOW_VIEWBOX.h}`}
          role="img"
          aria-label={FLOW_ALT}
        >
          <defs>
            <marker id="pkgmap-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>

          {EDGES.map((e) => (
            <g key={e.id} className={`pkgmap-edge${litEdges.has(e.id) ? " is-hot" : ""}`}>
              <path
                className={e.dashed ? "pkgmap-flow-dash" : "pkgmap-flow"}
                d={e.d}
                markerEnd="url(#pkgmap-arrow)"
              />
              {e.label && (
                <text className="pkgmap-t-edge" x={e.labelX} y={e.labelY} textAnchor="middle">
                  {e.label}
                </text>
              )}
            </g>
          ))}

          {NODES.map((n) => {
            const cx = n.x + n.w / 2;
            const isStored = n.id === "stored";
            return (
              <g
                key={n.id}
                className={[
                  "pkgmap-node",
                  n.stuck ? "is-stuck" : "",
                  lit.has(n.id) ? "is-hot" : "",
                  pinned === n.id ? "is-pinned" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                tabIndex={0}
                role="button"
                aria-pressed={pinned === n.id}
                aria-label={n.label}
                onMouseEnter={() => setHovered(n.id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(n.id)}
                onBlur={() => setHovered(null)}
                onClick={() => toggle(n.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(n.id);
                  }
                  if (e.key === "Escape") setPinned(null);
                }}
              >
                <rect className="pkgmap-box" x={n.x} y={n.y} width={n.w} height={n.h} rx={9} />

                {isStored ? (
                  <>
                    <text className="pkgmap-t-title" x={cx} y={n.y + 26} textAnchor="middle">
                      {n.label}
                    </text>
                    {CONTAINERS.map((c, i) => (
                      <g key={c}>
                        <rect
                          className="pkgmap-chip"
                          x={n.x + 16}
                          y={n.y + 42 + i * 36}
                          width={n.w - 32}
                          height={30}
                          rx={6}
                        />
                        <text className="pkgmap-t-chip" x={n.x + 28} y={n.y + 61 + i * 36}>
                          {c}
                        </text>
                      </g>
                    ))}
                  </>
                ) : (
                  <>
                    <text
                      className="pkgmap-t-title"
                      x={cx}
                      y={n.y + (n.lines?.length === 2 ? 28 : 24)}
                      textAnchor="middle"
                    >
                      {n.label}
                    </text>
                    {(n.lines ?? []).map((line, i) => (
                      <text
                        key={line}
                        className="pkgmap-t-sub"
                        x={cx}
                        y={n.y + (n.lines?.length === 2 ? 45 : 41) + i * 14}
                        textAnchor="middle"
                      >
                        {line}
                      </text>
                    ))}
                    {n.code && (
                      <text className="pkgmap-t-code" x={cx} y={n.y + 41} textAnchor="middle">
                        {n.code}
                      </text>
                    )}
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <p className="pkgmap-caption">
        Every package runs these six steps, whatever is inside it. A crate isn&rsquo;t a step — it&rsquo;s one of the
        places a package sits, which is why it sits inside <em>Stored</em> next to the conex and the shelf.
      </p>

      <div className="pkgmap-detail" aria-live="polite">
        {detail ? (
          <>
            <div className="pkgmap-detail-head">
              <h3>{detail.label}</h3>
              {pinned && (
                <button type="button" className="pkgmap-clear" onClick={() => setPinned(null)}>
                  Clear
                </button>
              )}
            </div>
            <dl>
              <dt>Who does it</dt>
              <dd>{detail.who}</dd>
              <dt>What the app asks for</dt>
              <dd>{detail.asks}</dd>
            </dl>
            <dl>
              <dt>What goes wrong here</dt>
              <dd>{detail.wrong}</dd>
            </dl>
          </>
        ) : (
          <>
            <h3>Tap a step</h3>
            <p className="pkgmap-detail-hint">
              Each one tells you who does it, what the app asks for, and what goes wrong there.
            </p>
          </>
        )}
      </div>

      <div className="pkgmap-note">
        <p>
          <strong>Why the part number matters more than it looks.</strong> The manufacturer already prints{" "}
          <span className="pkgmap-code">#16 2/3</span> on every package. That second number is the whole trick:
          the very first package to turn up tells the app that door #16 comes in three pieces. So the app can say{" "}
          <strong>&ldquo;2 of 3 here, hardware hasn&rsquo;t arrived&rdquo;</strong> without anyone ever typing a
          parts list.
        </p>
        <p>Some windows are one package. Some are six. Nobody has to know which in advance — the label says.</p>
      </div>
    </div>
  );
}
