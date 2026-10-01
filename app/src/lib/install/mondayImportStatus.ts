// Per-file status for the Plans page's "Files on Monday" block (F5 retry).
//
// Pulling a file and READING it are two different operations — the pull only
// writes bytes onto the job, nothing has been through a PDF parser yet — so
// this module is careful to never say more than the pull itself proved.

import type { MondayPullResult } from "../mondaySync";

/**
 * Recognises the sentence a pull leaves behind when it never reached the
 * server at all: supabase-js's own fixed `FunctionsFetchError` text ("Failed
 * to send a request to the Edge Function") and the generic offline line
 * `formatApiError` falls back to for a bare fetch failure. Both are transport
 * noise, not a decision the server made, so the Plans page swaps them for one
 * bilingual reconnect-and-retry line rather than showing an installer the
 * words "Edge Function".
 */
export function isOfflineMondayError(message: string | null | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("failed to send a request to the edge function") ||
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network request failed") ||
    lower.includes("load failed") ||
    lower.includes("appear to be offline") ||
    lower.includes("check your connection")
  );
}

export interface MondayFileStatusText {
  ok: boolean;
  /** "Added to Plans" / "Already on the job" / "Not added" — color-independent. */
  label: string;
  /** Why, when it failed — the server's own sentence, or the offline line. */
  detail?: string;
  /** Only on a fresh plans/specs landing: it is saved, not yet read. */
  note?: string;
}

export interface MondayFileStatusCatalog {
  toPlans: string;
  toSpecs: string;
  toDocuments: string;
  already: string;
  failed: string;
  offline: string;
  needsRead: string;
}

/**
 * Turn one file's pull outcome into the label/detail/note a row shows.
 *
 * `already` never gets the "needs read" note — the pull doesn't know whether
 * an already-present file was read on an earlier visit, so it says nothing
 * rather than guessing either way. A document never gets the note either: a
 * document needs no extraction, so there is nothing to tell it to do.
 */
export function mondayFileStatusText(
  outcome: { result?: MondayPullResult; topError?: string | null },
  catalog: MondayFileStatusCatalog,
): MondayFileStatusText {
  const { result, topError } = outcome;
  if (result?.ok) {
    const label = result.already
      ? catalog.already
      : result.where === "plans"
        ? catalog.toPlans
        : result.where === "specs"
          ? catalog.toSpecs
          : catalog.toDocuments;
    const note =
      !result.already && (result.where === "plans" || result.where === "specs")
        ? catalog.needsRead
        : undefined;
    return { ok: true, label, note };
  }
  const raw = result?.error?.trim() || topError?.trim() || "";
  const detail = raw ? (isOfflineMondayError(raw) ? catalog.offline : raw) : undefined;
  return { ok: false, label: catalog.failed, detail };
}
