// The thin door that replaced unit intake (ticket 21, ADR-0005).
//
// This screen used to CREATE window units: type a code, mint a WIN- id, put
// it on a rack. That whole chain retired — packages are the only material
// record now, planned per window number — but /receive is a bookmark in
// foremen's heads and on their phones, so the address keeps working and
// walks them to where the work went.

import { Link } from "react-router-dom";
import { BackChip } from "../components/BackChip";

export function Receive() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">Warehouse</p>
          <h1>Receiving is packages now</h1>
        </div>
      </header>
      <p className="muted" style={{ maxWidth: 520 }}>
        The old unit intake lived here. Material is tracked as packages now:
        labels get planned and printed from the job&rsquo;s Warehouse tab
        before the truck, and everything at the truck itself — sticking
        pre-printed labels, tagging the rest off the blank roll — happens on
        one screen.
      </p>
      <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 10 }}>
        <Link className="button-like active-pill" to="/storage/tag">
          Tag packages (truck)
        </Link>
        <Link className="button-like" to="/warehouse">
          Warehouse
        </Link>
      </div>
    </div>
  );
}
