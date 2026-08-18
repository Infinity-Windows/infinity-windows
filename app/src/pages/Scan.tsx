import { BackChip } from "../components/BackChip";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Scanner } from "../components/Scanner";
import {
  findWindowByCode,
  findWindowBySerial,
  getLocationByAddress,
  getLocationBySerial,
  getWindowByWindowId,
} from "../lib/api";
import type { QrPayload } from "../lib/qr";
import { resolveLocationFromScan, resolveWindowFromScan } from "../lib/scanResolve";
import { getContainerBySerial, getPackageBySerial } from "../lib/storage";
import { formatApiError } from "../lib/errors";

const windowLookups = { getWindowByWindowId, findWindowByCode, findWindowBySerial };
const locationLookups = { getLocationByAddress, getLocationBySerial };

export function Scan() {
  const navigate = useNavigate();
  const [message, setMessage] = useState<string | null>(null);

  // One resolver for every scanned label: a window/short-code/serial jumps to
  // the unit, a slot label jumps to the slot, anything else explains itself.
  const handleScan = async (payload: QrPayload) => {
    setMessage(null);
    try {
      if (payload.kind === "location" || payload.kind === "locationSerial") {
        const res = await resolveLocationFromScan(payload, locationLookups);
        if (res.status === "ok") {
          navigate(`/loc/${encodeURIComponent(res.location.address)}`);
        } else if (res.status === "not-found") {
          setMessage(`No slot found for "${res.query}".`);
        }
        return;
      }
      // Storage labels: a conex door poster opens the container, a package
      // sticker opens the package's sheet.
      if (payload.kind === "containerSerial") {
        const c = await getContainerBySerial(payload.serial);
        if (c) navigate(`/storage/c/${c.id}`);
        else setMessage(`No container found for "${payload.serial}".`);
        return;
      }
      if (payload.kind === "packageSerial") {
        const p = await getPackageBySerial(payload.serial);
        if (p) navigate(`/pkg/${p.serial}`);
        else setMessage(`No package found for "${payload.serial}".`);
        return;
      }
      const res = await resolveWindowFromScan(payload, windowLookups);
      if (res.status === "ok") {
        navigate(`/w/${encodeURIComponent(res.unit.window_id)}`);
      } else if (res.status === "not-found") {
        setMessage(`No window found for "${res.query}".`);
      } else {
        setMessage("That's a slot label — scan a window label.");
      }
    } catch (e) {
      setMessage(formatApiError(e));
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Scan</h1>
          <p className="muted" style={{ margin: 0 }}>
            Window label → unit. Slot label → what's in it.
          </p>
        </div>
        <BackChip fallback="/warehouse" label="Warehouse" />
      </header>
      <div className="detail-card" style={{ padding: 12 }}>
        <Scanner
          hint="Scan a window label to see or move it. Scan a slot label to see what's in it."
          onScan={(payload) => void handleScan(payload)}
        />
      </div>

      {/* Scanner already has its own typed-entry box, and it resolves everything
          a scan can (windows, slots, container serials, package serials) through
          the same handleScan path. A second typed box here only ever found
          windows, and the link that used to sit below it pointed at /search,
          which just redirects to Warehouse and drops whatever was typed. One
          working door beats three, two of which lied about what they did. */}
      {message && <p className="error">{message}</p>}
    </div>
  );
}
