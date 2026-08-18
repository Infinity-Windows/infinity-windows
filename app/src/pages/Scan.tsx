import { BackChip } from "../components/BackChip";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Scanner } from "../components/Scanner";
import { getLocationByAddress, getLocationBySerial } from "../lib/api";
import { resolveLocationFromScan } from "../lib/scanResolve";
import type { QrPayload } from "../lib/qr";
import { getContainerBySerial, getPackageBySerial } from "../lib/storage";
import { formatApiError } from "../lib/errors";

const locationLookups = { getLocationByAddress, getLocationBySerial };

export function Scan() {
  const navigate = useNavigate();
  const [message, setMessage] = useState<string | null>(null);

  // One resolver for every scanned label: a sticker opens its package, a conex
  // poster its container, a slot label its shelf — and an old-chain unit label
  // gets a plain answer instead of a dead page (ticket 21).
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
      // Old-chain window labels (WIN- serials, W- ids) stopped resolving when
      // the unit chain retired (ticket 21). The paper is still on some frames;
      // the answer is honest instead of a dead page.
      // Old-chain window labels (WIN- serials, W- ids, 5-char unit codes)
      // stopped resolving when the unit chain retired (ticket 21). The paper
      // is still on some frames; the answer is honest instead of a dead page.
      setMessage(
        "That's an old unit label — stickers replaced these. Tag the package at the truck and scan the sticker instead.",
      );
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
