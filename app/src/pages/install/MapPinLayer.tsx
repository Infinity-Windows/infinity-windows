// The pins drawn on top of the job drawing.
//
// Extracted from ProjectMap because it carries the one rule that decides
// whether a 42-mark page is readable: a pin encodes TWO things, not five.
//
//   fill  = status      planned / assigned / installed — what a crew scans for
//   shape = door/window square vs circle — the other thing you need at a glance
//
// Everything else a pin used to shout at once — installer initials, route
// sequence, the window/door colour — now appears where it is actually being
// used: dispatch mode, or the detail card after a tap. Mark numbers appear when
// there is room for them (few marks, zoomed in, or a deliberate toggle) and on
// the selected pin, because 42 always-on labels is 42 overlapping words.

import type { PointerEvent as ReactPointerEvent } from "react";
import {
  OPENING_STATUS_COLORS,
  openingMarkCode,
  type ProjectOpening,
} from "../../lib/install/types";
import { openingMarkerStyle } from "../../lib/install/openingMarkerScale";
import { openingUnitKind } from "../../lib/install/unitKind";
import { showsVoidedInstall } from "../../lib/install/openingRowAction";
import { installerInitials } from "../../lib/install/mapDispatch";
import { VOIDED_RING_COLOR } from "../../components/install/OpeningDetailCard";
import type { LayoutPoint } from "../../lib/install/pinLayout";

export interface MapPinLayerProps {
  openings: ProjectOpening[];
  /** Display position per opening id, already separated for overlap. */
  positions: Map<string, LayoutPoint>;
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
  /** Whether mark numbers are drawn on every pin. */
  showMarkNumbers: boolean;
  pinTitle: (opening: ProjectOpening) => string;
  onPinPointerDown: (
    opening: ProjectOpening,
  ) => (event: ReactPointerEvent<HTMLButtonElement>) => void;
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
  pinTitle,
  onPinPointerDown,
}: MapPinLayerProps) {
  return (
    <>
      {openings.map((o) => {
        const pos = positions.get(o.id);
        if (!pos) return null;
        const isDoor = openingUnitKind(o) === "door";
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
            aria-label={pinTitle(o)}
            aria-pressed={
              dispatchMode ? selIndex >= 0 || isNewOnRoute : undefined
            }
            className={`plan-dot${isDoor ? " plan-dot--door" : ""}${
              autoIds.has(o.id) ? " plan-dot--auto" : ""
            }${isSelected ? " plan-dot--selected" : ""}${
              draggingId === o.id ? " plan-dot--dragging" : ""
            }${selIndex >= 0 || isNewOnRoute ? " plan-dot--dispatch-selected" : ""}${
              onRoute && !isNewOnRoute ? " plan-dot--dispatch-route" : ""
            }${dimmed ? " plan-dot--dispatch-dim" : ""}${
              showLabel ? "" : " plan-dot--quiet"
            }`}
            style={{
              left: `${pos.x * 100}%`,
              top: `${pos.y * 100}%`,
              ...box,
              fontSize,
              background: OPENING_STATUS_COLORS[o.status],
              borderColor: isVoided ? VOIDED_RING_COLOR : undefined,
            }}
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
