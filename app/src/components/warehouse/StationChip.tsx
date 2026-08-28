// "② Off the truck" (wave F) — tells you which of the five warehouse
// stations this page belongs to, and taps back to the hub, where the whole
// flow shows. One consistent spot on every chipped page: top, near the
// existing BackChip/heading. Numbers and names come from
// lib/warehouse/stations.ts, the same module the hub's strip reads, so a
// chip can never name a station the hub doesn't.
import { Link } from "react-router-dom";
import { STATION_HUB_ROUTE, stationNumeral, type Station } from "../../lib/warehouse/stations";

export function StationChip({ station }: { station: Station }) {
  return (
    <Link to={STATION_HUB_ROUTE} className="station-chip">
      <span aria-hidden="true">{stationNumeral(station.number)}</span> {station.name}
    </Link>
  );
}
