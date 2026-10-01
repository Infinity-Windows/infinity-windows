import { signInMark, stillSignedInAs, subscribeSignedIn } from "./signedIn";
import { supabase } from "./supabase";

/** Bind both dispatch and completion to one sign-in. Supabase awaits its token
 * before fetch: aborting the actual request signal closes that account-switch
 * gap, rather than merely hiding a result after a write used the next login. */
export async function runQcOwnedRequest<T>(
  viewerId: string, lifetime: AbortSignal, send: (signal: AbortSignal) => Promise<T>,
  querySignal?: AbortSignal,
): Promise<T> {
  const mark = signInMark();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const checkOwner = () => { if (!stillSignedInAs(mark, viewerId)) abort(); };
  const unsubscribe = subscribeSignedIn(checkOwner);
  lifetime.addEventListener("abort", abort, { once: true });
  querySignal?.addEventListener("abort", abort, { once: true });
  if (lifetime.aborted || querySignal?.aborted) abort();
  checkOwner();
  try {
    controller.signal.throwIfAborted();
    const result = await send(controller.signal);
    checkOwner();
    controller.signal.throwIfAborted();
    return result;
  } finally {
    unsubscribe();
    lifetime.removeEventListener("abort", abort);
    querySignal?.removeEventListener("abort", abort);
  }
}

// Same existing learning/service contracts, with request-local cancellation.
// Shared clients and their other callers keep their existing behavior.
export async function addQcPriorityTerm(term: string, code: string, signal: AbortSignal): Promise<void> {
  const { error } = await supabase.from("learn_priority_terms")
    .upsert({ term_id: term, reason: `callback on ${code}` }, { onConflict: "term_id" }).abortSignal(signal);
  if (error) throw error;
}

export async function openQcServiceCase(windowId: string, code: string, term: string, signal: AbortSignal): Promise<void> {
  const { error } = await supabase.rpc("open_service_case", {
    p_window_id: windowId, p_reason: "QC callback", p_fail_point: term || null,
    p_description: `Opened from QC callback on ${code}`,
  }).abortSignal(signal);
  if (error) throw error;
}
