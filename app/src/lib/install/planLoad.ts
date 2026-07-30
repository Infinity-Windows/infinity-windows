// Guardrails for opening a planset on a phone.
//
// The plan panel used to show "Loading original plan…" until the app was
// closed. Two different faults produced that same dead end: something threw and
// the panel had no error state to move to, or a promise simply never settled —
// a pdf.js worker that fails to fetch on a weak job-site signal resolves
// nothing and rejects nothing. An installer on a roof cannot tell either apart
// from a slow download, so both now end in a message and a Retry button.

import { formatFieldError } from "./errors";

/**
 * How long to wait before calling it a failure. Generous: a 3 MB architectural
 * sheet over a bad site connection is genuinely slow, and a spurious timeout
 * would be its own bug. Well short of "forever", which is what it replaced.
 */
export const PLAN_LOAD_TIMEOUT_MS = 45_000;

/** Marker for a wait that ran out, so callers can word that case differently. */
export class PlanLoadTimeout extends Error {
  constructor(ms: number) {
    super(`Plan load exceeded ${ms}ms`);
    this.name = "PlanLoadTimeout";
  }
}

/**
 * Reject once `ms` has passed, so a promise that never settles cannot leave the
 * panel spinning. The timer is always cleared, including on the happy path, so
 * this never keeps a phone awake or fires after the user has moved on.
 */
export function withPlanTimeout<T>(
  work: Promise<T>,
  ms: number = PLAN_LOAD_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PlanLoadTimeout(ms)), ms);
  });
  return Promise.race([work, limit]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Wording browsers use when a download does not arrive. Safari's is the bare
 * "Load failed", which reads like a shrug on a phone screen — it names no cause
 * and suggests no action, so it gets translated like any other engine text.
 */
const NETWORK_FAILURE_PATTERNS = [
  /^load failed$/i,
  /failed to fetch/i,
  /network\s*error/i,
  /networkerror/i,
  /connection (was )?(lost|closed|refused)/i,
  /the internet connection appears to be offline/i,
  /err_(internet_disconnected|network|connection)/i,
];

function looksLikeNetworkFailure(err: unknown): boolean {
  const text =
    err instanceof Error ? err.message : typeof err === "string" ? err : null;
  return text ? NETWORK_FAILURE_PATTERNS.some((re) => re.test(text.trim())) : false;
}

/** Plain-English wording for a plan that would not open. Never engine text. */
export function planLoadMessage(err: unknown): string {
  if (err instanceof PlanLoadTimeout || (err as Error)?.name === "PlanLoadTimeout") {
    return "The plan is taking too long to open — your signal may be weak. Tap Retry to try again.";
  }
  if (looksLikeNetworkFailure(err)) {
    return "Could not download the plan — check your signal, then tap Retry.";
  }
  return formatFieldError(
    err,
    "This plan could not be opened on this device. Tap Retry to try again.",
  );
}
