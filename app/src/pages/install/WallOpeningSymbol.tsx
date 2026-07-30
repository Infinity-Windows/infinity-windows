import type { WallOpeningGeometry } from "../../lib/install/cad";

/**
 * The plan symbol that goes in a wall gap: a window as a thin double line
 * across the opening, a door as a leaf swinging into the room with its arc.
 *
 * Shared by the hand-drawn model editor and the derived job map so both draw an
 * opening the same way. Anything interactive belongs in `children`, which is
 * rendered last so it sits on top.
 */
export function WallOpeningSymbol(props: {
  geo: WallOpeningGeometry;
  color: string;
  /** Multiply stroke widths by this (pass 1/zoom to keep lines screen-constant). */
  strokeScale?: number;
  /** Thicken the symbol, for a selected feature. */
  emphasis?: boolean;
  children?: React.ReactNode;
}) {
  const { geo: g, color, strokeScale = 1, emphasis = false, children } = props;
  const zs = strokeScale;
  const weight = emphasis ? 1.6 : 1;

  if (g.kind === "window") {
    // Classic plan window: thin double line spanning the gap, closed at the
    // jambs. The spacing scales with the stroke, or the two lines merge into one
    // smudge at the weights the job map needs to be visible on a phone.
    const off = 4 * zs;
    return (
      <g style={{ pointerEvents: "none" }}>
        <line
          x1={g.ax + g.nx * off}
          y1={g.ay + g.ny * off}
          x2={g.bx + g.nx * off}
          y2={g.by + g.ny * off}
          stroke={color}
          strokeWidth={2 * zs * weight}
        />
        <line
          x1={g.ax - g.nx * off}
          y1={g.ay - g.ny * off}
          x2={g.bx - g.nx * off}
          y2={g.by - g.ny * off}
          stroke={color}
          strokeWidth={2 * zs * weight}
        />
        <line
          x1={g.ax}
          y1={g.ay}
          x2={g.ax + g.nx * off * 2}
          y2={g.ay + g.ny * off * 2}
          stroke={color}
          strokeWidth={2 * zs * weight}
        />
        <line
          x1={g.bx}
          y1={g.by}
          x2={g.bx + g.nx * off * 2}
          y2={g.by + g.ny * off * 2}
          stroke={color}
          strokeWidth={2 * zs * weight}
        />
        {children}
      </g>
    );
  }

  // Door: leaf from the hinge (gap start) swinging into the interior, with a
  // quarter-circle swing arc back to the strike side.
  const leafX = g.ax + g.nx * g.width;
  const leafY = g.ay + g.ny * g.width;
  // Sweep flag chosen so the arc bows from leaf tip to the strike jamb.
  const cross = g.nx * (g.by - g.ay) - g.ny * (g.bx - g.ax);
  const sweep = cross > 0 ? 0 : 1;
  return (
    <g style={{ pointerEvents: "none" }}>
      <line
        x1={g.ax}
        y1={g.ay}
        x2={leafX}
        y2={leafY}
        stroke={color}
        strokeWidth={3 * zs * weight}
      />
      <path
        d={`M${leafX.toFixed(1)} ${leafY.toFixed(1)} A${g.width.toFixed(1)} ${g.width.toFixed(1)} 0 0 ${sweep} ${g.bx.toFixed(1)} ${g.by.toFixed(1)}`}
        fill="none"
        stroke={color}
        strokeWidth={1.5 * zs * weight}
        strokeDasharray={`${6 * zs} ${5 * zs}`}
      />
      {children}
    </g>
  );
}
