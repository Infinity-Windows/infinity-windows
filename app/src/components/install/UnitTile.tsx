import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { Info, Users } from "lucide-react";
// The tile's own rules live with the Plan, where it was first drawn.
import "../../pages/installerPilot/jobPlanner.css";
import "./unitTile.css";

type DataProps = { [key: `data-${string}`]: string | boolean | undefined };

/**
 * One unit as a tile: its picture, its number, who leads it, and where it
 * stands. The Plan's unit picker drew this; Workday drew two others of its
 * own, with different parts in different places and different words (Matt,
 * 2026-11-20: "make unit tiles the same"). Every screen that shows a grid of
 * units uses this one, inside a `.jp-unit-options` (the Plan) or a
 * `.unit-tiles` grid (anywhere else).
 */
export function UnitTile({ code, codeExtra, picture, lead, crewCount = 0, status, statusTitle, done, card, pick, info, children, after }: {
  code: string;
  /** A mark beside the number, such as the whole-unit-complete check. */
  codeExtra?: ReactNode;
  picture: ReactNode;
  /** The lead's first name, or "You". */
  lead?: string;
  crewCount?: number;
  status?: ReactNode;
  statusTitle?: string;
  done?: boolean;
  /** Class and state attributes for the tile itself. */
  card?: HTMLAttributes<HTMLDivElement> & DataProps;
  /** What tapping the tile does: pick it, or start its timer. */
  pick: ButtonHTMLAttributes<HTMLButtonElement> & DataProps;
  /** The information button in the tile's corner. */
  info?: ButtonHTMLAttributes<HTMLButtonElement>;
  /** More for the caption, between the lead and the status: Workday's clock. */
  children?: ReactNode;
  /** Other buttons that sit over the tile, such as deselect. */
  after?: ReactNode;
}) {
  return <div {...card} className={`jp-unit-card ${card?.className ?? ""}`.trim()} data-done={done}>
    <div className="jp-unit-pick">
      <button type="button" {...pick}>
        <span className="jp-unit-visual" aria-hidden="true">{picture}</span>
        <span className="jp-unit-caption">
          <strong>{code}{codeExtra}</strong>
          {(lead || crewCount > 0) && <span className="jp-unit-member-summary"
            aria-label={[lead && `Lead: ${lead}`, crewCount > 0 && `${crewCount} crew`].filter(Boolean).join(", ")}>
            {lead && <span title={lead}>{lead}</span>}
            {crewCount > 0 && <span><Users size={10} aria-hidden="true" />{crewCount}</span>}
          </span>}
          {children}
          {status !== undefined && <small className="jp-unit-status" title={statusTitle} data-done={done}>{status}</small>}
        </span>
      </button>
    </div>
    {after}
    {info && <button type="button" {...info} className={`jp-unit-info-trigger ${info.className ?? ""}`.trim()}><Info size={15} aria-hidden="true" /></button>}
  </div>;
}
