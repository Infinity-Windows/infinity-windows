import { useMemo, type PointerEvent as ReactPointerEvent } from "react";
import {
  outlinePathWithOpenings,
  wallOpeningGeometry,
} from "../../lib/install/cad";
import type { OutlinePoint } from "../../lib/install/outline";
import type { SnappedOpening } from "../../lib/install/wallSnap";
import { WallOpeningSymbol } from "./WallOpeningSymbol";

const WALL_COLOR = "rgba(224, 218, 209, 0.9)";
const INTERIOR_FILL = "rgba(214, 208, 199, 0.10)";
/**
 * Symbol weight relative to the CAD defaults. A 2-unit stroke is 0.7px on a
 * phone — six times finer than the wall it sits in, which is invisible. This
 * puts a window line at roughly half the weight of a wall: lighter than the
 * structure, which is correct, but actually there.
 */
const SYMBOL_WEIGHT = 2.6;

/**
 * Radius of the invisible disc you actually tap, in viewBox units. About 24px
 * on a phone: the same target a pin had, so nothing got harder to hit by losing
 * its dot.
 */
const HIT_RADIUS = 32;
/** Mark number size and how far inside the wall it sits, in viewBox units. */
const LABEL_SIZE = 34;
const LABEL_INSET = 30;

/**
 * The building, drawn as walls, optionally with windows and doors cut into them.
 *
 * A gap comes out of the wall stroke, so an opening drawn this way is literally
 * a hole in the wall rather than a dot sitting near one, and the opening is also
 * the thing you tap.
 *
 * The job map passes no openings: cutting them into a derived shape took the
 * mark numbers and the window/door colours off the map, and on a job with no
 * hand-traced outline it cut holes into a rectangle nobody drew. There the marks
 * are pins on top of these walls. Openings are still drawn here for a plan
 * somebody traced by hand, where the wall really is where they say it is.
 */
export function MapWallLayer(props: {
  points: OutlinePoint[];
  aspect: number;
  outlinePath: string;
  openings?: SnappedOpening[];
  /** Install status colour for an opening, or undefined for the wall colour. */
  colorFor?: (id: string) => string | undefined;
  selectedId?: string | null;
  strokeScale?: number;
  wallStroke: number;
  /** Mark number to draw beside an opening, or null to leave it unlabelled. */
  labelFor?: (id: string) => string | null;
  titleFor?: (id: string) => string;
  onOpeningPointerDown?: (id: string) => (event: ReactPointerEvent) => void;
}) {
  const {
    points,
    aspect,
    outlinePath,
    openings = [],
    colorFor,
    selectedId,
    strokeScale = 1,
    wallStroke,
    labelFor,
    titleFor,
    onOpeningPointerDown,
  } = props;

  const geos = useMemo(
    () =>
      openings
        .map((o) => wallOpeningGeometry(points, aspect, o))
        .filter((g): g is NonNullable<typeof g> => !!g),
    [openings, points, aspect],
  );

  const edgeLengths = useMemo(() => {
    const h = 1000 * (aspect > 0 ? aspect : 0.7);
    return points.map((p, i) => {
      const q = points[(i + 1) % points.length];
      return Math.hypot((q.x - p.x) * 1000, (q.y - p.y) * h);
    });
  }, [points, aspect]);

  const gappedPath = useMemo(
    () => outlinePathWithOpenings(points, aspect, openings),
    [points, aspect, openings],
  );

  const perimeter = edgeLengths.reduce((sum, length) => sum + length, 0);

  return (
    <g data-outline-perimeter={String(perimeter)}>
      <path d={outlinePath} fill={INTERIOR_FILL} stroke="none" />
      {/*
       * Corners are mitred: the whole point of squaring the polygon up was to
       * get sharp ones, and rounding them here would throw that away.
       */}
      <path
        d={gappedPath ?? outlinePath}
        fill="none"
        stroke={WALL_COLOR}
        strokeWidth={wallStroke * strokeScale}
        strokeLinejoin="miter"
      />
      {geos.map((g) => {
        const selected = selectedId === g.id;
        const cx = (g.ax + g.bx) / 2;
        const cy = (g.ay + g.by) / 2;
        const label = labelFor?.(g.id) ?? null;
        const opening = openings.find((o) => o.id === g.id);
        const center =
          opening != null
            ? opening.t * (edgeLengths[opening.edge] ?? 0)
            : 0;
        return (
          // Tagged so the screenshot harness can count how many marks on a page
          // became openings without inferring it from the picture.
          <g
            key={g.id}
            data-wall-opening={g.id}
            data-opening-kind={g.kind}
            data-opening-edge={opening != null ? String(opening.edge) : undefined}
            data-opening-center={String(center)}
            data-opening-width={String(g.width)}
            onPointerDown={onOpeningPointerDown?.(g.id)}
            style={{
              cursor: onOpeningPointerDown ? "pointer" : undefined,
              // Steal the gesture from the pan/scroll viewport so a drag on a
              // window moves the mark instead of the sheet.
              touchAction: "none",
            }}
          >
            {titleFor && <title>{titleFor(g.id)}</title>}
            <WallOpeningSymbol
              geo={g}
              color={colorFor?.(g.id) ?? WALL_COLOR}
              strokeScale={strokeScale * SYMBOL_WEIGHT}
              emphasis={selected}
            />
            {selected && (
              <circle
                cx={cx}
                cy={cy}
                r={HIT_RADIUS * 0.62}
                fill="none"
                stroke={colorFor?.(g.id) ?? WALL_COLOR}
                strokeWidth={3 * strokeScale}
              />
            )}
            {label && (
              // Just inside the wall, so it never sits on top of its own symbol.
              <text
                data-opening-label={g.id}
                x={cx + g.nx * LABEL_INSET}
                y={cy + g.ny * LABEL_INSET}
                fill={colorFor?.(g.id) ?? WALL_COLOR}
                fontSize={LABEL_SIZE * strokeScale}
                fontWeight={700}
                textAnchor="middle"
                dominantBaseline="central"
                style={{ pointerEvents: "none" }}
              >
                {label}
              </text>
            )}
            {/*
              The tap target, last so it is on top of everything it belongs to.
              A window symbol is a few thin lines; nobody hits that with a glove
              on, so the thing you aim at is a disc over the whole opening.
            */}
            <circle
              cx={cx}
              cy={cy}
              r={HIT_RADIUS}
              fill="transparent"
              stroke="none"
            />
          </g>
        );
      })}
    </g>
  );
}
