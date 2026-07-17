import { Link, useNavigate } from "react-router-dom";
import { Scanner } from "../components/Scanner";

export function Scan() {
  const navigate = useNavigate();

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Scan</h1>
          <p className="muted" style={{ margin: 0 }}>
            Window label → unit. Slot label → what's in it.
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">‹</Link>
      </header>
      <div className="detail-card" style={{ padding: 12 }}>
        <Scanner
          hint="Scan a window label to see or move it. Scan a slot label to see what's in it."
          onScan={(payload) => {
            if (payload.kind === "window") {
              navigate(`/w/${encodeURIComponent(payload.windowId)}`);
            } else {
              navigate(`/loc/${encodeURIComponent(payload.address)}`);
            }
          }}
        />
      </div>
      <Link to="/search" className="action-btn">
        Or search by ID →
      </Link>
    </div>
  );
}
