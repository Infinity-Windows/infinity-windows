import { Html5Qrcode, Html5QrcodeScannerState } from "html5-qrcode";
import { useEffect, useRef, useState } from "react";
import { parseQr, type QrPayload } from "../lib/qr";

interface ScannerProps {
  onScan: (payload: QrPayload) => void;
  hint?: string;
}

export function Scanner({ onScan, hint }: ScannerProps) {
  const containerId = useRef(
    `qr-scanner-${Math.random().toString(36).slice(2)}`,
  );
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    const scanner = new Html5Qrcode(containerId.current);
    let stopped = false;

    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decoded) => {
          const payload = parseQr(decoded);
          if (payload) {
            if (navigator.vibrate) navigator.vibrate(80);
            onScanRef.current(payload);
          }
        },
        () => {},
      )
      .catch((err) => {
        if (!stopped) {
          setError(
            err?.message ??
              "Camera unavailable. Type the ID below instead.",
          );
        }
      });

    return () => {
      stopped = true;
      try {
        const state = scanner.getState();
        if (
          state === Html5QrcodeScannerState.SCANNING ||
          state === Html5QrcodeScannerState.PAUSED
        ) {
          scanner
            .stop()
            .then(() => {
              try {
                scanner.clear();
              } catch {
                /* ignore */
              }
            })
            .catch(() => {});
        } else {
          try {
            scanner.clear();
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* scanner never initialized; nothing to clean up */
      }
    };
  }, []);

  const submitManual = () => {
    const payload = parseQr(manual);
    if (payload) {
      onScan(payload);
      setManual("");
      setError(null);
    } else {
      setError("Not a valid window ID or slot address.");
    }
  };

  return (
    <div className="scanner">
      <div id={containerId.current} className="scanner-viewport" />
      {hint && <p className="scanner-hint">{hint}</p>}
      {error && <p className="error">{error}</p>}
      <div className="manual-entry">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Or type ID: W-CAS3050-0042 / S-03-B"
          onKeyDown={(e) => e.key === "Enter" && submitManual()}
        />
        <button onClick={submitManual}>Go</button>
      </div>
    </div>
  );
}
