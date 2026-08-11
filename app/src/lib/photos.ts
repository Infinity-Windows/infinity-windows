// Data layer for the live job photo feed. Reads attachments (kind 'photo') for
// a project or across all jobs, resolves signed URLs from the private
// install-media bucket, and degrades gracefully when the additive geo/feed
// columns (20260721002000) are not yet applied.

import { supabase } from "./supabase";
import { isMissingColumn as isMissingSchemaColumn } from "./schemaErrors";

export interface FeedPhoto {
  id: string;
  storagePath: string;
  signedUrl: string | null;
  createdBy: string | null;
  createdAt: string;
  takenAt: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  caption: string | null;
  projectId: string | null;
}

const GEO_SELECT =
  "id, kind, storage_path, created_by, created_at, project_id, lat, lng, accuracy_m, taken_at, caption";
const BASE_SELECT = "id, kind, storage_path, created_by, created_at";

function isMissingColumn(err: unknown): boolean {
  return isMissingSchemaColumn(err);
}

interface AttachmentRow {
  id: string;
  storage_path: string;
  created_by: string | null;
  created_at: string;
  project_id?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracy_m?: number | null;
  taken_at?: string | null;
  caption?: string | null;
}

/** Best-effort signed URL for a "bucket/path" storage reference. */
async function signedMedia(storagePath: string): Promise<string | null> {
  const slash = storagePath.indexOf("/");
  const bucket = slash >= 0 ? storagePath.slice(0, slash) : "install-media";
  const path = slash >= 0 ? storagePath.slice(slash + 1) : storagePath;
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, 3600);
  if (error) return null;
  return data.signedUrl;
}

/**
 * List job photos newest-first. Pass a projectId to scope to one job, or omit
 * for the "recent across all jobs" view. When the geo columns are missing the
 * project filter can't apply, so we fall back to a recent-all query.
 */
export async function listPhotos(
  projectId?: string | null,
  limit = 60,
): Promise<FeedPhoto[]> {
  let query = supabase
    .from("attachments")
    .select(GEO_SELECT)
    .eq("kind", "photo")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (projectId) query = query.eq("project_id", projectId);
  let res = await query;

  if (res.error && isMissingColumn(res.error)) {
    const fallback = await supabase
      .from("attachments")
      .select(BASE_SELECT)
      .eq("kind", "photo")
      .order("created_at", { ascending: false })
      .limit(limit);
    res = fallback as typeof res;
  }
  if (res.error) throw res.error;

  const rows = (res.data ?? []) as AttachmentRow[];
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      storagePath: r.storage_path,
      signedUrl: await signedMedia(r.storage_path),
      createdBy: r.created_by ?? null,
      createdAt: r.created_at,
      takenAt: r.taken_at ?? null,
      lat: typeof r.lat === "number" ? r.lat : null,
      lng: typeof r.lng === "number" ? r.lng : null,
      accuracyM: typeof r.accuracy_m === "number" ? r.accuracy_m : null,
      caption: r.caption ?? null,
      projectId: r.project_id ?? null,
    })),
  );
}

/** Prefer the true capture time; fall back to the server insert time. */
export function photoTime(p: Pick<FeedPhoto, "takenAt" | "createdAt">): string {
  return p.takenAt ?? p.createdAt;
}

export interface PhotoDayGroup<T> {
  key: string;
  label: string;
  photos: T[];
}

/**
 * Group an already-sorted (newest-first) photo list into day buckets, keeping
 * input order within and across groups. `timeZone` is exposed for deterministic
 * tests; production uses the device's local zone.
 */
export function groupPhotosByDay<
  T extends Pick<FeedPhoto, "takenAt" | "createdAt">,
>(photos: T[], timeZone?: string): PhotoDayGroup<T>[] {
  const tz = timeZone ? { timeZone } : {};
  const keyFmt = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...tz,
  });
  const labelFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...tz,
  });
  const groups: PhotoDayGroup<T>[] = [];
  const byKey = new Map<string, PhotoDayGroup<T>>();
  for (const p of photos) {
    const d = new Date(photoTime(p));
    const key = keyFmt.format(d);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: labelFmt.format(d), photos: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.photos.push(p);
  }
  return groups;
}
