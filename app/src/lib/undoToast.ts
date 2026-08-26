// The app-wide undo toast (owner pick 25): "Every state-changing tap gets
// the same five-second 'Done — Undo' toast... the tailgate taught us the
// pattern; the whole app deserves it." Module-level event bus, the same
// shape lib/toast.ts already uses — no context, no provider, a host
// component just subscribes and renders.
//
// One toast at a time: a new call replaces whatever is showing, and the
// replaced action's undo is simply dropped — the same rule any single-slot
// toast already follows. This store only owns the countdown and the pending
// undo closure; screens decide what "undo" means for their own action.

import { formatApiError } from "./errors";
import { pushToast } from "./toast";

/** How long a toast stays up, and what the draining bar animates over —
 *  exported so the host component's CSS and this module's tests agree on
 *  one number instead of two copies drifting apart. */
export const UNDO_TOAST_MS = 5000;

export interface UndoToastState {
  id: number;
  message: string;
  /** True while hovered/focused — the host stops the CSS bar too, so the
   *  two never disagree about whether time is passing. */
  paused: boolean;
}

interface Active {
  id: number;
  message: string;
  undo: () => Promise<void>;
  /** Time left when not currently running (updated on pause). */
  remainingMs: number;
  /** Wall-clock start of the current running stretch; null while paused. */
  armedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

type Listener = (state: UndoToastState | null) => void;

const listeners = new Set<Listener>();
let active: Active | null = null;
let seq = 0;

function toState(a: Active): UndoToastState {
  return { id: a.id, message: a.message, paused: a.armedAt == null };
}

function emit(): void {
  const state = active ? toState(active) : null;
  for (const l of listeners) l(state);
}

function clearTimer(a: Active): void {
  if (a.timer != null) {
    clearTimeout(a.timer);
    a.timer = null;
  }
}

function dismiss(): void {
  if (active) clearTimer(active);
  active = null;
  emit();
}

/**
 * Show a toast for a just-completed action that has a real inverse. One at a
 * time — a second call before the first expires replaces it outright.
 */
export function showUndoToast(args: { message: string; undo: () => Promise<void> }): void {
  if (active) clearTimer(active);
  const id = ++seq;
  active = {
    id,
    message: args.message,
    undo: args.undo,
    remainingMs: UNDO_TOAST_MS,
    armedAt: Date.now(),
    timer: setTimeout(dismiss, UNDO_TOAST_MS),
  };
  emit();
}

/** Hover/focus pause (house rule: nothing here moves layout — only the
 *  timer and the CSS animation's play-state change). */
export function pauseUndoToast(): void {
  if (!active || active.armedAt == null) return;
  active.remainingMs = Math.max(0, active.remainingMs - (Date.now() - active.armedAt));
  clearTimer(active);
  active.armedAt = null;
  emit();
}

export function resumeUndoToast(): void {
  if (!active || active.armedAt != null) return;
  if (active.remainingMs <= 0) {
    dismiss();
    return;
  }
  active.armedAt = Date.now();
  active.timer = setTimeout(dismiss, active.remainingMs);
  emit();
}

/**
 * Run the pending undo. The toast closes either way — a failed undo does not
 * leave a toast standing that promises a second try will work; the failure
 * surfaces through the app's ordinary error toast instead.
 */
export async function fireUndo(): Promise<void> {
  const a = active;
  if (!a) return;
  dismiss();
  try {
    await a.undo();
  } catch (err) {
    pushToast(`Couldn't undo — ${formatApiError(err)}`, "error");
  }
}

export function subscribeUndoToast(fn: Listener): () => void {
  listeners.add(fn);
  fn(active ? toState(active) : null);
  return () => listeners.delete(fn);
}
