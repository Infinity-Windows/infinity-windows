import { Link } from "react-router-dom";

/**
 * The two real ways past a unit that still owes flashing.
 *
 * There used to be a DISABLED button here reading "Flash this opening first",
 * which is the exact thing the owner reported on 2026-09-02 as "the button
 * doesn't register": it named an action and did nothing, and nothing else on
 * the sheet said where that action lives. Flashing is its own pass on the
 * flash run, and a foreman can decide this unit was never going to be flashed
 * — so those are the two things this offers, both as controls that actually do
 * something. Shown wherever the flashing gate stops someone — moved here
 * unchanged from OpeningSheet.tsx (S7) since both CheckStage and
 * CaptureStage need it.
 */
export function FlashingWayOut({
  projectId,
  openingCode,
  canClear,
  clearing,
  onClear,
}: {
  projectId: string;
  openingCode: string;
  canClear: boolean;
  clearing: boolean;
  onClear: () => void;
}) {
  return (
    <div className="detail-card wh-card" style={{ textAlign: "left" }}>
      <p className="wh-row-sub" style={{ margin: 0 }}>
        Flashing is its own pass, not part of this install. Open the flash run
        and pick {openingCode} from its list.
      </p>
      <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 8 }}>
        <Link className="action-btn" to={`/projects/${projectId}/flash-run`}>
          Go to the flash run
        </Link>
        {canClear && (
          <button className="action-btn" disabled={clearing} onClick={onClear}>
            Doesn't need flashing
          </button>
        )}
      </div>
    </div>
  );
}
