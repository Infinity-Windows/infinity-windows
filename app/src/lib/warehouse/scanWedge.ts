// Hardware barcode/QR scanners plugged in (or paired) as a keyboard wedge
// fire real keydown events for every character on the label, then Enter —
// indistinguishable from typing except for speed: a scanner's characters
// land far faster than any human keystroke pace. Pick 30 detects that burst
// and routes it the same way a camera scan does, so a desk-mounted wedge
// scanner works on the warehouse pages without the camera flow at all.
//
// The detector (wedgeStep) is a pure reducer — timestamps and keys in,
// state and a verdict out — so the timing rule can be proven without a DOM.
// useScanWedge is the one DOM-touching piece: a window keydown listener,
// mounted only while a warehouse-area page is on screen.

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { parseQr } from "../qr";
import { playSuccessTone } from "../sound";
import { resolveStorageFromScan, type StorageScanLookups } from "../scanResolve";
import { getContainerBySerial, getPackageBySerial } from "../storage";

/** A burst resets if two characters are more than this far apart — well
 * above anything a scanner produces (single-digit milliseconds) and well
 * below the fastest plausible human keystroke-to-keystroke gap. */
export const WEDGE_MAX_GAP_MS = 35;

/** Below this many characters, an Enter is somebody's own keystroke, not a
 * label — every real serial/QR payload this app prints is longer. */
export const WEDGE_MIN_LENGTH = 6;

export interface WedgeKeyEvent {
  /** DOM KeyboardEvent.key — a length-1 string for every printable
   * character a scanner can send; "Enter" ends a burst; anything else
   * (Shift, Tab, arrow keys, …) is neither. */
  key: string;
  /** Monotonic milliseconds (KeyboardEvent.timeStamp / performance.now()). */
  at: number;
}

export type WedgeVerdict =
  | { kind: "idle" }
  | { kind: "collecting" }
  /** Enter arrived with a long-enough buffer: hand `text` to the parser. */
  | { kind: "scanned"; text: string }
  /** Enter arrived too soon — a stray keystroke, not a label. */
  | { kind: "ignored" };

export interface WedgeState {
  buffer: string;
  lastAt: number | null;
}

export const WEDGE_IDLE: WedgeState = { buffer: "", lastAt: null };

/**
 * One key event in, the next state and a verdict out. Pure: no timers, no
 * DOM, nothing outside the two arguments — the whole burst rule lives here
 * so it can be exercised with a plain array of {key, at} pairs.
 */
export function wedgeStep(
  state: WedgeState,
  event: WedgeKeyEvent,
): { state: WedgeState; verdict: WedgeVerdict } {
  if (event.key === "Enter") {
    if (state.buffer.length >= WEDGE_MIN_LENGTH) {
      return { state: WEDGE_IDLE, verdict: { kind: "scanned", text: state.buffer } };
    }
    return { state: WEDGE_IDLE, verdict: { kind: "ignored" } };
  }

  // Only a single printable character extends (or starts) a burst. A
  // scanner never sends a modifier or navigation key mid-payload, so one
  // showing up here is unrelated human input — pass it through without
  // disturbing whatever burst may already be forming.
  if (event.key.length !== 1) {
    return { state, verdict: { kind: state.buffer ? "collecting" : "idle" } };
  }

  const withinBurst = state.lastAt != null && event.at - state.lastAt < WEDGE_MAX_GAP_MS;
  const buffer = withinBurst ? state.buffer + event.key : event.key;
  return { state: { buffer, lastAt: event.at }, verdict: { kind: "collecting" } };
}

/** True while focus sits in something that should keep every keystroke for
 * itself — typing a note in a warehouse-page textbox must never be hijacked
 * mid-word because it happened to type fast. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

const storageLookups: StorageScanLookups = { getContainerBySerial, getPackageBySerial };

/**
 * Install the keyboard-wedge listener for as long as the calling component
 * is mounted. Call this from warehouse-area pages only (Warehouse,
 * DeliveryDetail, ContainerDetail, TagPackages) — everywhere else, a fast
 * typist (or a scanner reused for something unrelated) should never route
 * the page away from under them.
 */
export function useScanWedge(): void {
  const navigate = useNavigate();

  useEffect(() => {
    let state: WedgeState = WEDGE_IDLE;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) {
        // The field gets it — and a burst that happened to be forming when
        // focus landed there must not bleed into whatever is typed next.
        state = WEDGE_IDLE;
        return;
      }
      const step = wedgeStep(state, { key: e.key, at: e.timeStamp });
      state = step.state;
      if (step.verdict.kind !== "scanned") return;

      const payload = parseQr(step.verdict.text);
      if (!payload) return;
      void resolveStorageFromScan(payload, storageLookups).then((res) => {
        if (res.status !== "ok") return;
        playSuccessTone();
        navigate(res.path);
      });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
}
