// What one window or door is, in one card.
//
// This started as the panel the map opens when you tap a pin. The window/door
// lists — on the Map tab and on Dispatch — now open the SAME card, because "let
// me see that one" is the same question wherever it gets asked, and two panels
// that drifted apart would be two answers to it. The card is presentational: it
// knows nothing about maps, dispatch, or how it was opened.

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { MarkElevationViews } from "./MarkElevationViews";
import { openingFullSheetPath } from "../../lib/install/openingRowAction";
import { openingUnitKind } from "../../lib/install/unitKind";
import { rememberOpening } from "../../lib/install/staleOpening";
import { installerInitials } from "../../lib/install/mapDispatch";
import {
  OPENING_KIND_COLORS,
  OPENING_STATUS_COLORS,
  openingMarkCode,
  type ProjectOpening,
} from "../../lib/install/types";

/** Distinct ring/text for an opening whose install was undone (foreman+ only). */
export const VOIDED_RING_COLOR = "#ef4444";

/** Extra facts read off the supplier's specs PDF, where that PDF is loaded. */
export interface OpeningSpecDetail {
  productCodes: string[];
  notes: string[];
  pageNumber: number;
}

interface OpeningDetailCardProps {
  projectId: string;
  opening: ProjectOpening;
  /** Foreman+ only: this install was undone and needs doing again. */
  voided?: boolean;
  /** The assignee's colour on the map, so the same person reads the same here. */
  installerColor?: string;
  detail?: OpeningSpecDetail | null;
  onClose: () => void;
  /** Offered only where the specs PDF is on screen to jump to. */
  onOpenDetailSheet?: (pageNumber: number) => void;
  /** Set when a list row opens this card, to tie the two together for a reader. */
  id?: string;
}

export function OpeningDetailCard({
  projectId,
  opening: o,
  voided = false,
  installerColor,
  detail = null,
  onClose,
  onOpenDetailSheet,
  id,
}: OpeningDetailCardProps) {
  const kind = openingUnitKind(o);
  const wt = o.window_types;

  // "Open full sheet" below is a link by id, and reloading the plans replaces
  // every opening with a new id. Note the code this id stood for while we have
  // it in hand, so a link followed after a re-extract still finds the same
  // window instead of a dead end (see staleOpening / OpeningMoved).
  useEffect(() => {
    rememberOpening(o.id, projectId, o.opening_code);
  }, [o.id, projectId, o.opening_code]);

  return (
    <div className="map-detail-card" id={id}>
      <div className="map-detail-card__head">
        <span
          className="map-detail-card__dot"
          style={{ background: OPENING_KIND_COLORS[kind] }}
          aria-hidden
        />
        <strong>
          #{openingMarkCode(o.opening_code)}
          {wt ? ` · ${wt.name || wt.type_code}` : ""}
        </strong>
        <span className="map-detail-card__cat">{wt?.category ?? kind}</span>
        <button
          type="button"
          className="map-detail-card__close"
          aria-label={`Close details for ${o.opening_code}`}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <dl className="map-detail-card__rows">
        {wt?.width_in != null && wt?.height_in != null && (
          <div>
            <dt>Size</dt>
            <dd>
              {wt.width_in}″ × {wt.height_in}″
            </dd>
          </div>
        )}
        <div>
          <dt>Status</dt>
          <dd
            style={{
              color: voided ? VOIDED_RING_COLOR : OPENING_STATUS_COLORS[o.status],
            }}
          >
            {voided ? "install undone — redo needed" : o.status}
          </dd>
        </div>
        {o.label && (
          <div>
            <dt>Location</dt>
            <dd>{o.label}</dd>
          </div>
        )}
        {o.assignee && (
          <div>
            <dt>Assigned</dt>
            <dd>
              <span
                className="map-detail-card__installer"
                style={{ background: installerColor ?? "#a39c92" }}
                aria-hidden
              >
                {installerInitials(o.assignee.display_name)}
              </span>
              {o.assignee.display_name}
              {o.sequence != null && ` · #${o.sequence}`}
              {` · ${o.status}`}
            </dd>
          </div>
        )}
        {o.ro_width_in != null && o.ro_height_in != null && (
          <div>
            <dt>Rough opening</dt>
            <dd>
              {o.ro_width_in}″ × {o.ro_height_in}″
            </dd>
          </div>
        )}
        {detail && detail.productCodes.length > 0 && (
          <div>
            <dt>Product</dt>
            <dd>{detail.productCodes.join(" · ")}</dd>
          </div>
        )}
      </dl>
      {wt?.notes && <p className="map-detail-card__notes">{wt.notes}</p>}
      {detail && detail.notes.length > 0 && (
        <p className="map-detail-card__notes">{detail.notes.join(" · ")}</p>
      )}
      {/* The plan says which room; the elevation says which hole in the wall.
          Renders nothing when this mark isn't drawn on a named elevation. */}
      <MarkElevationViews
        projectId={projectId}
        markCode={o.opening_code}
        variant="bare"
      />
      <div className="map-detail-card__actions">
        <Link
          to={openingFullSheetPath(projectId, o.id)}
          className="button-like"
        >
          Open full sheet
        </Link>
        {detail && onOpenDetailSheet && (
          <button
            type="button"
            className="link"
            onClick={() => onOpenDetailSheet(detail.pageNumber)}
          >
            Detail sheet — PDF page {detail.pageNumber}
          </button>
        )}
      </div>
    </div>
  );
}
