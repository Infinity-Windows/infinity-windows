// The pins drawn on top of the job drawing.
//
// A pin answers the three questions a crew member asks of a mark, in the order
// they ask them:
//
//   number = which mark this is        — always drawn, never earned
//   fill   = window (blue) or door (green)
//   ring   = status: planned / assigned / installed, or red for an undone install
//
// The window/door colour was briefly moved off the pin and replaced by a status
// fill, which on a job where every opening is `planned` painted all 42 marks the
// same yellow. A crew cannot tell a door from a window in that picture, and the
// number — the only thing separating two identical windows — was switched off on
// any page with more than fourteen marks. Both are back on by default; the
// Numbers chip on the map turns labels off for anyone who wants a bare page.
//
// Installer initials and route sequence still only appear in dispatch mode,
// which is the only time a pin means anything by them.

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  OPENING_KIND_COLORS,
  OPENING_STATUS_COLORS,
  openingMarkCode,
  type ProjectOpening,
} from "../../lib/install/types";
import { openingMarkerStyle } from "../../lib/install/openingMarkerScale";
import { showsVoidedInstall } from "../../lib/install/openingRowAction";
import { installerInitials } from "../../lib/install/mapDispatch";
import { VOIDED_RING_COLOR } from "../../components/install/OpeningDetailCard";

/** A point on the sheet, both axes 0–1 across the page. */
export interface PinPoint {
  x: number;
  y: number;
}

export interface MapPinLayerProps {
  openings: ProjectOpening[];
  /**
   * Where to draw each opening, keyed by id — its own pin_x/pin_y, so the dot
   * lands on the callout number the extractor read it off.
   */
  positions: Map<string, PinPoint>;
  /** Openings whose position was inferred rather than placed by a person. */
  autoIds: Set<string>;
  selectedId: string | null;
  draggingId: string | null;
  dispatchMode: boolean;
  /** Dispatch tap order. */
  selection: string[];
  routeOrder: Map<string, number>;
  routeNewIds: Set<string>;
  hasRoute: boolean;
  crewColors: Map<string, string>;
  voidedIds: ReadonlySet<string>;
  effectiveRole: string | null | undefined;
  /** Whether mark numbers are drawn on every pin. On unless turned off. */
  showMarkNumbers: boolean;
  /**
   * Door or window for this job, reading the schedule's own style where there
   * is one — it decides both the pin's colour and its shape, so it has to come
   * from the same answer the filters and the list use.
   */
  unitKind: (opening: ProjectOpening) => "door" | "window";
  /** Below foreman a mark cannot be moved, so it must not look draggable. */
  canMoveMarks: boolean;
  /** Marks moved recently enough to still be undoable. */
  movedIds: ReadonlySet<string>;
  pinTitle: (opening: ProjectOpening) => string;
  onPinPointerDown: (
    opening: ProjectOpening,
  ) => (event: ReactPointerEvent) => void;
}

export function MapPinLayer({
  openings,
  positions,
  autoIds,
  selectedId,
  draggingId,
  dispatchMode,
  selection,
  routeOrder,
  routeNewIds,
  hasRoute,
  crewColors,
  voidedIds,
  effectiveRole,
  showMarkNumbers,
  unitKind,
  canMoveMarks,
  movedIds,
  pinTitle,
  onPinPointerDown,
}: MapPinLayerProps) {
  return (
    <>
      {openings.map((o) => {
        const pos = positions.get(o.id);
        if (!pos) return null;
        const isDoor = unitKind(o) === "door";
        const isVoided = showsVoidedInstall(effectiveRole, o, voidedIds);
        const isSelected = selectedId === o.id;
        const selIndex = selection.indexOf(o.id);
        const routeNum = hasRoute ? routeOrder.get(o.id) : undefined;
        const onRoute = routeNum != null;
        const isNewOnRoute = onRoute && routeNewIds.has(o.id);
        const dimmed = hasRoute && !onRoute;
        // Route position when a foreman is building a run, plain tap order
        // otherwise. Both are dispatch concepts, so neither shows to a crew
        // member just looking for their next window.
        const seqNum = dispatchMode
          ? onRoute
            ? routeNum
            : selIndex >= 0
              ? selIndex + 1
              : null
          : null;
        const installerColor = o.assigned_to
          ? crewColors.get(o.assigned_to)
          : undefined;
        const showInstallerBadge =
          dispatchMode && !!installerColor && seqNum == null && !dimmed;
        // The number is what tells two identical windows apart, so the selected
        // pin always shows it even when the page is too crowded for the rest.
        const showLabel = showMarkNumbers || isSelected;
        const { fontSize, ...box } = openingMarkerStyle(o.id);
        return (
          <button
            key={o.id}
            type="button"
            /*
             * Which opening this dot is, so a test can check that it landed on
             * the callout it belongs to. Two openings can share a mark number,
             * so the visible label is not an identity.
             */
            data-opening-id={o.id}
            aria-label={pinTitle(o)}
            aria-pressed={
              dispatchMode ? selIndex >= 0 || isNewOnRoute : undefined
            }
            className={`plan-dot${isDoor ? " plan-dot--door" : ""}${
              canMoveMarks ? "" : " plan-dot--fixed"
            }${autoIds.has(o.id) ? " plan-dot--auto" : ""}${
              movedIds.has(o.id) ? " plan-dot--moved" : ""
            }${isSelected ? " plan-dot--selected" : ""}${
              draggingId === o.id ? " plan-dot--dragging" : ""
            }${selIndex >= 0 || isNewOnRoute ? " plan-dot--dispatch-selected" : ""}${
              onRoute && !isNewOnRoute ? " plan-dot--dispatch-route" : ""
            }${dimmed ? " plan-dot--dispatch-dim" : ""}${
              showLabel ? "" : " plan-dot--quiet"
            }`}
            /*
             * Colours go through custom properties, not `background`, so a page
             * with labels switched off can shrink the visible dot with a
             * pseudo-element while the button itself stays a full-size tap
             * target. Shrinking the button would make pins unhittable in gloves.
             */
            style={
              {
                left: `${pos.x * 100}%`,
                top: `${pos.y * 100}%`,
                ...box,
                fontSize,
                "--pin-fill": OPENING_KIND_COLORS[isDoor ? "door" : "window"],
                "--pin-ring": isVoided
                  ? VOIDED_RING_COLOR
                  : OPENING_STATUS_COLORS[o.status],
              } as CSSProperties
            }
            title={
              isVoided
                ? `${pinTitle(o)} — install undone, needs re-do`
                : pinTitle(o)
            }
            onPointerDown={onPinPointerDown(o)}
          >
            {showLabel && (
              <span className="plan-dot__mark">
                {openingMarkCode(o.opening_code)}
              </span>
            )}
            {showInstallerBadge && (
              <span
                className="plan-dot__installer"
                style={{ background: installerColor }}
                aria-hidden
              >
                {installerInitials(o.assignee?.display_name ?? "?")}
              </span>
            )}
            {seqNum != null && (
              <span className="plan-dot__seq" aria-hidden>
                {seqNum}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}
