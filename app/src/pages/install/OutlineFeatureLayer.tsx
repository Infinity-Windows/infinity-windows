import { useMemo } from "react";
import {
  wallOpeningGeometry,
  type OutlineFeatures,
  type WallOpening,
} from "../../lib/install/cad";
import type { OutlinePoint } from "../../lib/install/outline";
import { WallOpeningSymbol } from "./WallOpeningSymbol";

/**
 * SVG layer for CAD-lite outline features: section divider lines and
 * window/door wall symbols. Renders inside an existing 1000×(1000*aspect)
 * viewBox. The wall gaps themselves are cut from the outline stroke via
 * outlinePathWithOpenings; this layer draws what goes in/next to the gaps.
 */
export function OutlineFeatureLayer(props: {
  points: OutlinePoint[];
  aspect: number;
  features: OutlineFeatures;
  color: string;
  /** Multiply stroke widths by this (pass 1/zoom to keep lines screen-constant). */
  strokeScale?: number;
  selectedFeatureId?: string | null;
  onSelectFeature?: (id: string, type: "divider" | "wall") => void;
}) {
  const {
    points,
    aspect,
    features,
    color,
    strokeScale = 1,
    selectedFeatureId,
    onSelectFeature,
  } = props;
  const zs = strokeScale;

  const wallGeos = useMemo(
    () =>
      features.wallOpenings
        .map((o: WallOpening) => wallOpeningGeometry(points, aspect, o))
        .filter((g): g is NonNullable<typeof g> => !!g),
    [features.wallOpenings, points, aspect],
  );

  const interactive = !!onSelectFeature;

  return (
    <g>
      {features.dividers.map((d) => {
        const selected = selectedFeatureId === d.id;
        return (
          <g key={d.id}>
            {interactive && (
              <line
                x1={d.a.x * 1000}
                y1={d.a.y * 1000 * aspect}
                x2={d.b.x * 1000}
                y2={d.b.y * 1000 * aspect}
                stroke="transparent"
                strokeWidth={22 * zs}
                style={{ pointerEvents: "stroke", cursor: "pointer" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelectFeature?.(d.id, "divider");
                }}
              />
            )}
            <line
              x1={d.a.x * 1000}
              y1={d.a.y * 1000 * aspect}
              x2={d.b.x * 1000}
              y2={d.b.y * 1000 * aspect}
              stroke={selected ? "#ffd166" : color}
              strokeWidth={(selected ? 4 : 2.5) * zs}
              strokeDasharray={`${14 * zs} ${8 * zs}`}
              strokeLinecap="round"
              style={{ pointerEvents: "none" }}
            />
          </g>
        );
      })}

      {wallGeos.map((g) => {
        const selected = selectedFeatureId === g.id;
        const stroke = selected ? "#ffd166" : color;
        const midX = (g.ax + g.bx) / 2;
        const midY = (g.ay + g.by) / 2;
        const hit = interactive ? (
          <circle
            cx={midX}
            cy={midY}
            r={20 * zs}
            fill="transparent"
            style={{ pointerEvents: "all", cursor: "pointer" }}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelectFeature?.(g.id, "wall");
            }}
          />
        ) : null;

        return (
          <WallOpeningSymbol key={g.id} geo={g} color={stroke} strokeScale={zs}>
            {hit}
          </WallOpeningSymbol>
        );
      })}
    </g>
  );
}
