// Tiny toast bus so swallowed errors surface to the user instead of failing
// silently. No dependency; a host component subscribes and renders.

export interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
}

type Listener = (toasts: Toast[]) => void;

const listeners = new Set<Listener>();
let toasts: Toast[] = [];
let seq = 0;

function emit() {
  for (const l of listeners) l(toasts);
}

export function pushToast(message: string, kind: Toast["kind"] = "info"): void {
  const t: Toast = { id: ++seq, message, kind };
  toasts = [...toasts, t];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, 4500);
}

export function toastError(err: unknown, fallback = "Something went wrong"): void {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
  pushToast(message || fallback, "error");
}

export function subscribeToasts(fn: Listener): () => void {
  listeners.add(fn);
  fn(toasts);
  return () => {
    listeners.delete(fn);
  };
}
