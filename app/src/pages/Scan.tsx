import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Scanner } from "../components/Scanner";
import {
  findWindowByCode,
  findWindowBySerial,
  getLocationBySerial,
} from "../lib/api";

export function Scan() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  const resolveCode = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    setMessage(null);
    setLooking(true);
    try {
      const unit = await findWindowByCode(value);
      if (unit) {
        navigate(`/w/${encodeURIComponent(unit.window_id)}`);
      } else {
        setMessage(`No window found for "${value}".`);
      }
    } catch (e) {
      setMessage(String(e));
    } finally {
      setLooking(false);
    }
  };

  // A serial-encoded QR resolves to the same destination as a legacy label.
  const resolveWindowSerial = async (serial: string) => {
    setMessage(null);
    setLooking(true);
    try {
      const unit = await findWindowBySerial(serial);
      if (unit) navigate(`/w/${encodeURIComponent(unit.window_id)}`);
      else setMessage(`No window found for serial "${serial}".`);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setLooking(false);
    }
  };

  const resolveLocationSerial = async (serial: string) => {
    setMessage(null);
    setLooking(true);
    try {
      const loc = await getLocationBySerial(serial);
      if (loc) navigate(`/loc/${encodeURIComponent(loc.address)}`);
      else setMessage(`No slot found for serial "${serial}".`);
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
          onScan={(payload) => {
            if (payload.kind === "window") {
              navigate(`/w/${encodeURIComponent(payload.windowId)}`);
            } else if (payload.kind === "windowCode") {
              void resolveCode(payload.code);
            } else if (payload.kind === "windowSerial") {
              void resolveWindowSerial(payload.serial);
            } else if (payload.kind === "locationSerial") {
              void resolveLocationSerial(payload.serial);
            } else {
              navigate(`/loc/${encodeURIComponent(payload.address)}`);
            }
          }}
        />
      </div>

      <label className="field-label">Or type the window code</label>
      <div className="manual-entry">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="6-char code or serial, e.g. K7M2QX"
          autoCapitalize="characters"
          onKeyDown={(e) => e.key === "Enter" && resolveCode(code)}
        />
        <button disabled={looking || !code.trim()} onClick={() => resolveCode(code)}>
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
