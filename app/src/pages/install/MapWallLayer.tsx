import { useMemo } from "react";
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
 * The building, drawn as walls with its windows and doors cut into them.
 *
 * The gaps come out of the wall stroke, so an opening is literally a hole in
 * the wall rather than a dot sitting near one, and each symbol is drawn in its
 * own install status colour. Only marks that were already on a wall get this
 * treatment; the rest stay as pins in `MapPinLayer`.
 */
export function MapWallLayer(props: {
  points: OutlinePoint[];
  aspect: number;
  outlinePath: string;
  openings: SnappedOpening[];
  /** Install status colour for an opening, or undefined for the wall colour. */
  colorFor: (id: string) => string | undefined;
  selectedId?: string | null;
  strokeScale?: number;
  wallStroke: number;
}) {
  const {
    points,
    aspect,
    outlinePath,
    openings,
    colorFor,
    selectedId,
    strokeScale = 1,
    wallStroke,
  } = props;

  const geos = useMemo(
    () =>
      openings
        .map((o) => wallOpeningGeometry(points, aspect, o))
        .filter((g): g is NonNullable<typeof g> => !!g),
    [openings, points, aspect],
  );

  const gappedPath = useMemo(
    () => outlinePathWithOpenings(points, aspect, openings),
    [points, aspect, openings],
  );

  return (
    <g>
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
      {geos.map((g) => (
        // Tagged so the screenshot harness can count how many marks on a page
        // became openings without inferring it from the picture.
        <g key={g.id} data-wall-opening={g.id} data-opening-kind={g.kind}>
          <WallOpeningSymbol
            geo={g}
            color={colorFor(g.id) ?? WALL_COLOR}
            strokeScale={strokeScale * SYMBOL_WEIGHT}
            emphasis={selectedId === g.id}
          />
        </g>
      ))}
    </g>
  );
}
