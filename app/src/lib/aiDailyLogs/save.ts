// Saving a Forge AI daily log contribution, and only then its photos.
//
// append_daily_log_contribution (20261030000000) is the only writer. The
// answer is sorted into four honest outcomes (draft.ts SaveOutcome); the one
// that matters most is `uncertain`: no response, a timeout, a dropped
// connection. The server may well have saved it, so the phone keeps the frozen
// payload and resends it — the id makes that a replay, never a second entry.
//
// Photos leave the phone only after a real receipt, only to the receipt's job,
// and through the existing upload queue (enqueueUpload) with the id minted when
// each was taken. The queue then owns the bytes, its two-minute deadline and
// its retry; a saved log never claims a photo arrived.
import { supabase } from "../supabase";
import { formatApiError } from "../errors";
import { isNetworkError } from "../offline/outbox-core";
import type { UploadInput } from "../offline/outbox";
import {
  markQueued,
  photosReadyToQueue,
  type AiDailyLogDraft,
  type ContributionReceipt,
  type ExistingLogSnapshot,
  type SaveOutcome,
  type SavePayload,
} from "./draft";

export const SAVE_TIMEOUT_MS = 30_000;

/** Read the server's answer. Anything unrecognised is not a receipt. */
export function classifySaveResponse(data: unknown, error: unknown): SaveOutcome {
  if (error) {
    const rec = error as { code?: unknown; name?: unknown; status?: unknown };
    const code = typeof rec.code === "string" ? rec.code : "";
    if (rec.name === "AbortError" || isNetworkError(error)) return { kind: "uncertain" };
    // A gateway or server failure says nothing about whether the row committed.
    if (typeof rec.status === "number" && rec.status >= 500) return { kind: "uncertain" };
    if (!code && !(typeof rec.status === "number" && rec.status >= 400)) return { kind: "uncertain" };
    return { kind: "rejected", message: formatApiError(error, "The daily log was not saved. Check the entry and try again.") };
  }
  const r = data as (Omit<Partial<ContributionReceipt>, "status"> & { status?: string; log?: ExistingLogSnapshot | null; current_revision?: number }) | null;
  if (r && (r.status === "saved" || r.status === "already_saved") && typeof r.contribution_id === "string" && typeof r.project_id === "string") {
    return { kind: "receipt", receipt: { ...r, photo_ids: Array.isArray(r.photo_ids) ? r.photo_ids : [] } as ContributionReceipt };
  }
  if (r && r.status === "stale" && typeof r.current_revision === "number") {
    return { kind: "stale", revision: r.current_revision, current: r.log ?? null };
  }
  return { kind: "uncertain" };
}

/** One attempt. Never throws: every failure is an outcome. */
export async function sendContribution(payload: SavePayload, timeoutMs = SAVE_TIMEOUT_MS): Promise<SaveOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { data, error } = await supabase
      .rpc("append_daily_log_contribution", {
        p_id: payload.id,
        p_actor: payload.actorId,
        p_project_id: payload.projectId,
        p_log_date: payload.logDate,
        p_expected_revision: payload.expectedRevision,
        p_answers: payload.answers,
        p_body: payload.body,
        p_photo_ids: payload.photoIds,
        p_source_request_ids: payload.sourceRequestIds,
      })
      .abortSignal(controller.signal);
    return classifySaveResponse(data, error);
  } catch (e) {
    return classifySaveResponse(null, e ?? new Error("failed"));
  } finally {
    clearTimeout(timer);
  }
}

/** The shared log as it is now, for the preview (revision 0 = none yet). */
export async function readSharedLog(projectId: string, logDate: string): Promise<ExistingLogSnapshot | null> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select("id, revision, notes, headline, day_flow, weather, reflection, filed_by, updated_at, filer:profiles!filed_by(display_name)")
    .eq("project_id", projectId)
    .eq("log_date", logDate)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as Omit<ExistingLogSnapshot, "filed_by_name"> & { filer?: { display_name: string | null } | null };
  return {
    id: row.id, revision: Number(row.revision ?? 1), notes: row.notes, headline: row.headline, day_flow: row.day_flow,
    weather: row.weather, reflection: row.reflection, filed_by: row.filed_by,
    filed_by_name: row.filer?.display_name ?? null, updated_at: row.updated_at,
  };
}

/** Which of a saved entry's photos the server has, on the right job, from its author. */
export interface ServerPhotoStatus { photo_id: string; arrived: boolean; attachment_id: string | null; storage_path: string | null }
export async function readServerPhotoStatus(contributionId: string): Promise<ServerPhotoStatus[]> {
  const { data, error } = await supabase.rpc("daily_log_contribution_photo_status", { p_contribution: contributionId });
  if (error) throw error;
  return Array.isArray(data) ? (data as ServerPhotoStatus[]) : [];
}

/** Stable per photo, so a repeated hand-off overwrites the same object. */
export function photoStoragePath(projectId: string, photoId: string): string {
  return `${projectId}/feed/ai-daily-log-${photoId}.jpg`;
}

/** The signed-in account as it is at this moment (UI and auth session agree). */
export type CurrentAccount = () => Promise<{ userId: string; email: string } | null>;

export interface QueuePhotoDeps {
  /** Asked again before EVERY photo, after its bytes are read: a sign-in change
   * part-way through leaves the rest on the phone with their own account. */
  account: CurrentAccount;
  getBlob: (photoId: string) => Promise<Blob | null>;
  enqueueUpload: (input: UploadInput) => Promise<string>;
  /** Record one hand-off on the stored draft before the next, applied to the
   * draft as it is THEN (not a snapshot from when the loop began). */
  recordQueued: (photoId: string) => Promise<void>;
  dropBlob: (photoId: string) => Promise<void>;
}
export interface QueuePhotoResult { draft: AiDailyLogDraft; failed: { photoId: string; message: string }[] }

/**
 * Hand the saved log's photos to the upload queue, one at a time. A photo the
 * queue will not take (too large, storage full, bytes gone) stays on the phone
 * and is reported; the others still go.
 */
export async function queueSavedPhotos(draft: AiDailyLogDraft, deps: QueuePhotoDeps): Promise<QueuePhotoResult> {
  const failed: QueuePhotoResult["failed"] = [];
  if (!draft.receipt) return { draft, failed };
  let current = draft;
  for (const photo of photosReadyToQueue(draft)) {
    try {
      const blob = await deps.getBlob(photo.id);
      if (!blob) throw new Error("This photo is no longer on this phone. Take it again.");
      const who = await deps.account();
      // Not this draft's account any more: stop. What is left stays on the
      // phone under its owner and goes when they are back.
      if (!who || who.userId !== draft.userId || !who.email) break;
      await deps.enqueueUpload({
        kind: "photo",
        bucket: "install-media",
        path: photoStoragePath(draft.receipt.project_id, photo.id),
        contentType: blob.type || "image/jpeg",
        projectId: draft.receipt.project_id,
        createdBy: who.email,
        caption: photo.caption,
        lat: photo.lat,
        lng: photo.lng,
        accuracyM: photo.accuracyM,
        takenAt: photo.takenAt,
        blob,
        clientId: photo.id,
      });
      current = markQueued(current, photo.id);
      await deps.recordQueued(photo.id);
      // The queue holds its own copy now; this one is no longer the only one.
      await deps.dropBlob(photo.id).catch(() => undefined);
    } catch (e) {
      failed.push({ photoId: photo.id, message: formatApiError(e, "This photo could not be queued. It is still on this phone.") });
    }
  }
  return { draft: current, failed };
}
