// Host for lib/undoToast.ts (owner pick 25). Mounted once in Layout, same
// as ToastHost — a screen never renders its own copy, it just calls
// showUndoToast().
//
// The outer element takes no pointer events (see index.css) — only the
// Undo button opts back in — so a toast sitting over a row's own button for
// five seconds cannot eat that tap. The hover/focus handlers still work:
// CSS pointer-events changes which element a click or hover lands ON, not
// how the resulting event bubbles, so entering/focusing the button still
// reaches this element and pauses the countdown.
import {
  fireUndo,
  pauseUndoToast,
  resumeUndoToast,
  subscribeUndoToast,
  UNDO_TOAST_MS,
  type UndoToastState,
} from "../lib/undoToast";
import { useEffect, useState } from "react";

export function UndoToast() {
  const [state, setState] = useState<UndoToastState | null>(null);
  useEffect(() => subscribeUndoToast(setState), []);

  if (!state) return null;

  return (
    <div
      className="undo-toast"
      role="status"
      aria-live="polite"
      onMouseEnter={pauseUndoToast}
      onMouseLeave={resumeUndoToast}
      onFocus={pauseUndoToast}
      onBlur={resumeUndoToast}
    >
      <span className="undo-toast-message">{state.message}</span>
      <button type="button" className="undo-toast-btn" onClick={() => void fireUndo()}>
        Undo
      </button>
      <span className="undo-toast-bar" aria-hidden="true">
        <span
          key={state.id}
          className="undo-toast-bar-fill"
          style={{
            animationDuration: `${UNDO_TOAST_MS}ms`,
            animationPlayState: state.paused ? "paused" : "running",
          }}
        />
      </span>
    </div>
  );
}
