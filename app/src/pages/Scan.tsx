import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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

const windowLookups = { getWindowByWindowId, findWindowByCode, findWindowBySerial };
const locationLookups = { getLocationByAddress, getLocationBySerial };

export function Scan() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  // One resolver for every scanned label: a window/short-code/serial jumps to
  // the unit, a slot label jumps to the slot, anything else explains itself.
  const handleScan = async (payload: QrPayload) => {
    setMessage(null);
    setLooking(true);
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
      const res = await resolveWindowFromScan(payload, windowLookups);
      if (res.status === "ok") {
        navigate(`/w/${encodeURIComponent(res.unit.window_id)}`);
      } else if (res.status === "not-found") {
        setMessage(`No window found for "${res.query}".`);
      } else {
        setMessage("That's a slot label — scan a window label.");
      }
    } catch (e) {
      setMessage(String(e));
    } finally {
      setLooking(false);
    }
  };

  // Typed entry accepts a 6-char code or a serial — resolve it as a window code
  // (the RPC handles both) and jump straight to the unit.
  const resolveTyped = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    setMessage(null);
    setLooking(true);
    try {
      const res = await resolveWindowFromScan(
        { kind: "windowCode", code: value },
        windowLookups,
      );
      if (res.status === "ok") {
        navigate(`/w/${encodeURIComponent(res.unit.window_id)}`);
      } else {
        setMessage(`No window found for "${value}".`);
      }
    } catch (e) {
      setMessage(String(e));
    } finally {
      setLooking(false);
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
        <Link to="/warehouse" className="back-chip" aria-label="Warehouse">‹</Link>
      </header>
      <div className="detail-card" style={{ padding: 12 }}>
        <Scanner
          hint="Scan a window label to see or move it. Scan a slot label to see what's in it."
          onScan={(payload) => void handleScan(payload)}
        />
      </div>

      <label className="field-label">Or type the window code</label>
      <div className="manual-entry">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="6-char code or serial, e.g. K7M2QX"
          autoCapitalize="characters"
          onKeyDown={(e) => e.key === "Enter" && resolveTyped(code)}
        />
        <button disabled={looking || !code.trim()} onClick={() => resolveTyped(code)}>
          {looking ? "…" : "Go"}
        </button>
      </div>
      {message && <p className="error">{message}</p>}

      <Link to="/search" className="action-btn">
        Or search by ID →
      </Link>
    </div>
  );
}
