import type { Html5Qrcode } from "html5-qrcode";
import { useEffect, useRef, useState } from "react";
import { parseQr, type QrPayload } from "../lib/qr";

// The camera decoder (html5-qrcode with its bundled ZXing port, ~105 kB
// gzipped) loads when a scanner opens, not with the app. This component is
// imported by the warehouse Find bar, the scan sheet and the opening sheet's
// Check step, all of which ship in the shell every phone downloads before its
// first screen, so a static import here put the whole decoder on that
// download for a camera most opens never start. The typed-ID box below needs
// none of it and works the moment the component mounts. The decoder's chunk
// is precached like every other, so scanning in a dead zone still works once
// the app is installed.
const CAMERA_UNAVAILABLE = "Camera unavailable. Type the ID below instead.";

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
    // Filled in once the decoder has loaded. The cleanup can run first (the
    // sheet closed while the chunk was still arriving); then there is no
    // camera to stop, and the load, finding `stopped`, never starts one.
    let running: { scanner: Html5Qrcode; lib: typeof import("html5-qrcode") } | null = null;

    import("html5-qrcode")
      .then((lib) => {
        if (stopped) return;
        // A production build resolves a chunk that failed to load to nothing:
        // preloadRecovery.ts has already dealt with the failure (reload once,
        // or say so), so all that is left is keeping the typed box usable.
        if (!lib) {
          setError(CAMERA_UNAVAILABLE);
          return;
        }
        const scanner = new lib.Html5Qrcode(containerId.current);
        running = { scanner, lib };
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
              setError(err?.message ?? CAMERA_UNAVAILABLE);
            }
          });
      })
      .catch(() => {
        // The dev server's form of the same failure: the import rejects. Its
        // message is a file address, not a sentence, so it is never shown.
        if (!stopped) setError(CAMERA_UNAVAILABLE);
      });

    return () => {
      stopped = true;
      if (!running) return;
      const { scanner, lib } = running;
      try {
        const state = scanner.getState();
        if (
          state === lib.Html5QrcodeScannerState.SCANNING ||
          state === lib.Html5QrcodeScannerState.PAUSED
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
