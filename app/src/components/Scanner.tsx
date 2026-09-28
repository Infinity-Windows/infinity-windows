import { useEffect, useRef, useState } from "react";
import { parseQr, type QrPayload } from "../lib/qr";

// Types only — `typeof import(...)` is erased at compile time, so this pins
// the shapes below without pulling html5-qrcode (and the camera code it
// wires up) into the first-screen bundle. The runtime `import("html5-qrcode")`
// happens inside the effect below, only once this box actually mounts.
type Html5QrcodeModule = typeof import("html5-qrcode");
type Html5QrcodeInstance = InstanceType<Html5QrcodeModule["Html5Qrcode"]>;
type Html5QrcodeScannerStateEnum = Html5QrcodeModule["Html5QrcodeScannerState"];

/**
 * Stop and release the camera. Called from two places that can race each
 * other: the effect's own unmount cleanup, and the late completion of a
 * `start()` call that was still pending when the box unmounted (the camera
 * turns on for a box that no longer exists — see the effect below). Safe to
 * call more than once; every step is defensive the same way the original
 * synchronous cleanup was.
 */
async function stopAndClear(
  scanner: Html5QrcodeInstance,
  ScannerState: Html5QrcodeScannerStateEnum,
) {
  try {
    const state = scanner.getState();
    if (state === ScannerState.SCANNING || state === ScannerState.PAUSED) {
      await scanner.stop();
    }
  } catch {
    /* never started, or already stopped */
  }
  try {
    scanner.clear();
  } catch {
    /* ignore */
  }
}

interface ScannerProps {
  onScan: (payload: QrPayload) => void;
  hint?: string;
  /**
   * Default true. The scan sheet (ScanSheet.tsx) passes false: it stacked
   * this box directly over its own typed-entry box, the same lookup
   * reachable two ways on one screen (audit 2026-08-17 item C) — its own box
   * stays as the SINGLE typed entry there. Every other caller (FindBar,
   * OpeningSheet, TagPackages) is unaffected by this prop's default.
   */
  showManualEntry?: boolean;
}

export function Scanner({ onScan, hint, showManualEntry = true }: ScannerProps) {
  const containerId = useRef(
    `qr-scanner-${Math.random().toString(36).slice(2)}`,
  );
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let stopped = false;
    let scanner: Html5QrcodeInstance | null = null;
    let ScannerState: Html5QrcodeScannerStateEnum | null = null;
    let startPending = false;

    const cleanupCamera = () => {
      // Clearing while start() is pending can detach the container before
      // the camera opens. Its completion handler performs the cleanup then.
      if (!startPending && scanner && ScannerState) void stopAndClear(scanner, ScannerState);
    };

    import("html5-qrcode")
      .then(({ Html5Qrcode, Html5QrcodeScannerState }) => {
        ScannerState = Html5QrcodeScannerState;
        // Unmounted while the module was still downloading: the container
        // div is gone, so don't even construct the scanner or open a camera.
        if (stopped) return;
        scanner = new Html5Qrcode(containerId.current);
        startPending = true;
        let startResult: Promise<unknown>;
        try {
          startResult = scanner.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 220, height: 220 } },
            (decoded) => {
              // Unmounted mid-scan (a decode event can still fire while
              // stop() is in flight): drop it, never call back into a
              // screen that has gone away.
              if (stopped) return;
              const payload = parseQr(decoded);
              if (payload) {
                if (navigator.vibrate) navigator.vibrate(80);
                onScanRef.current(payload);
              }
            },
            () => {},
          );
        } catch (err) {
          startPending = false;
          if (stopped) cleanupCamera();
          else setError(err instanceof Error ? err.message : "Camera unavailable. Type the ID below instead.");
          return;
        }
        return startResult
          .then(() => {
            startPending = false;
            // start() finished after we'd already unmounted: it just turned
            // the camera on for a box that no longer exists. Turn it back
            // off instead of leaving it running unseen.
            if (stopped) cleanupCamera();
          })
          .catch((err) => {
            startPending = false;
            if (stopped) cleanupCamera();
            if (!stopped) {
              setError(
                err?.message ??
                  "Camera unavailable. Type the ID below instead.",
              );
            }
          });
      })
      .catch(() => {
        // The html5-qrcode chunk itself failed to download. Vite's error for
        // that carries the raw asset URL ("Failed to fetch dynamically
        // imported module: <url>") — not something to show an installer.
        if (!stopped) {
          setError("Camera unavailable. Type the ID below instead.");
        }
      });

    return () => {
      stopped = true;
      cleanupCamera();
    };
  }, []);

  const submitManual = () => {
    const payload = parseQr(manual);
    if (payload) {
      onScan(payload);
      setManual("");
      setError(null);
    } else {
      setError("Not a valid unit ID or slot address.");
    }
  };

  return (
    <div className="scanner">
      <div id={containerId.current} className="scanner-viewport" />
      {hint && <p className="scanner-hint">{hint}</p>}
      {error && <p className="error">{error}</p>}
      {showManualEntry && (
        <div className="manual-entry">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Or type ID: W-CAS3050-0042 / S-03-B"
            onKeyDown={(e) => e.key === "Enter" && submitManual()}
          />
          <button onClick={submitManual}>Go</button>
        </div>
      )}
    </div>
  );
}
