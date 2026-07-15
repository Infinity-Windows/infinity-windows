import { useNavigate } from "react-router-dom";
import { Scanner } from "../components/Scanner";

export function Scan() {
  const navigate = useNavigate();

  return (
    <div className="page">
      <header className="page-header">
        <h1>Scan</h1>
      </header>
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
  );
}
