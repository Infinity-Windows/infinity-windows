// The role maps' renderer — the package map's visual grammar, generalized.
//
// This component holds no facts: every box, tie, coordinate and sentence
// comes from lib/roleFlow.ts, which is test-pinned — including the one test
// that matters most, that a map can never name a door its role cannot open.
// Touch first, like PackageMap: tap pins, tap again releases. Hover only
// repaints INSIDE the svg (highlight + dimming) — it must never mount or
// unmount the detail card below, because the card changes the page's height,
// which moves the cursor off the node, which removes the card, which moves
// it back… an oscillation that visibly shakes the screen (owner-reported,
// 2026-08-18). Only a tap may change what takes up space.

import { useState } from "react";
import { Link } from "react-router-dom";
import {
  doorLabel,
  layoutRoleFlow,
  ROLE_FLOW_W,
  type RoleFlow,
} from "../lib/roleFlow";

export function RoleMap({ flow }: { flow: RoleFlow }) {
  const { nodes, edges, viewBox } = layoutRoleFlow(flow);
  const [pinned, setPinned] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const active = pinned ?? hovered;
  const detail = nodes.find((n) => n.id === pinned) ?? null;

  return (
    <div className="pkgmap">
      <p className="pkgmap-lede">{flow.lede}</p>
      <div style={{ overflowX: "auto" }}>
        <svg
          viewBox={`0 0 ${ROLE_FLOW_W} ${viewBox.h}`}
          style={{ width: "100%", maxWidth: 720, display: "block", margin: "0 auto" }}
          role="img"
          aria-label={flow.title}
        >
          <defs>
            <marker
              id={`roleflow-arrow-${flow.role}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {edges.map((e) => (
            <path
              key={`${e.from}-${e.to}`}
              d={e.d}
              fill="none"
              stroke="currentColor"
              strokeWidth={e.dashed ? 1.2 : 1.5}
              strokeDasharray={e.dashed ? "5 4" : undefined}
              opacity={active && active !== e.from && active !== e.to ? 0.25 : 0.7}
              markerEnd={`url(#roleflow-arrow-${flow.role})`}
            />
          ))}
          {nodes.map((n) => {
            const on = active === n.id;
            return (
              <g
                key={n.id}
                onClick={() => setPinned((cur) => (cur === n.id ? null : n.id))}
                onMouseEnter={() => setHovered(n.id)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: "pointer" }}
              >
                <rect
                  x={n.x}
                  y={n.y}
                  width={n.w}
                  height={n.h}
                  rx={10}
                  fill={on ? "var(--accent-soft)" : "transparent"}
                  stroke={on ? "var(--accent-line)" : "currentColor"}
                  strokeWidth={on ? 2 : n.branch ? 1 : 1.5}
                  strokeDasharray={n.branch && !on ? "5 4" : undefined}
                  opacity={active && !on ? 0.55 : 1}
                />
                <text
                  x={n.x + n.w / 2}
                  y={n.y + 24}
                  textAnchor="middle"
                  fontSize={14.5}
                  fontWeight={600}
                  fill="currentColor"
                >
                  {n.label}
                </text>
                {(n.lines ?? []).map((line, i) => (
                  <text
                    key={i}
                    x={n.x + n.w / 2}
                    y={n.y + 44 + i * 15}
                    textAnchor="middle"
                    fontSize={11.5}
                    fill="currentColor"
                    opacity={0.75}
                  >
                    {line}
                  </text>
                ))}
              </g>
            );
          })}
        </svg>
      </div>

      {detail ? (
        <div className="detail-card" style={{ marginTop: 8, padding: "10px 14px" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>{detail.label}</p>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13.5 }}>
            {detail.asks}
          </p>
          {detail.wrong && (
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
              <strong>Worth knowing:</strong> {detail.wrong}
            </p>
          )}
          {detail.doors.length > 0 && (
            <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 8 }}>
              {detail.doors.map((d) => (
                <Link key={d} className="button-like studio-mini" to={d}>
                  {doorLabel(d)}
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
          Tap a step to see what it asks, what goes wrong, and the doors it
          opens — every door is real and yours.
        </p>
      )}
    </div>
  );
}
