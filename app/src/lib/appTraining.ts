// "Using Forge" walkthroughs (2026-09-23): narrated videos of PROPOSED app
// designs, one per role floor, inside Learn. docs/role-training-videos.md is
// the runbook; supabase/migrations/20261025000000_app_training_videos.sql is
// the lock.
//
// NOT LESSONS. Nothing here writes anything: no learning time, no points, no
// quiz, no clearance, no "watched" record. A walkthrough shows how the app
// COULD work; treating one as study, or as an approved way to work, is the
// mistake the whole feature is shaped to prevent.
//
// TWO FILTERS, ONE LOCK. The database decides from the caller's REAL role who
// may read a row or sign an object. The screen then narrows again by the
// EFFECTIVE role, so an owner previewing "installer" sees exactly the
// installer's shelf — a filter that can only hide, never grant.
//
// NOTHING KEPT. The catalog's query-key root is registered offline: false, the
// signed links live in component state and die with it, and the service worker
// is told to leave the bucket's URLs alone (lib/privateMedia.ts).

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";
import { APP_TRAINING_BUCKET } from "./privateMedia";

export type TrainingSlug = "installer" | "foreman" | "leadership";
export type TrainingFloor = "installer" | "foreman" | "supervisor";
export type TrainingChapterStatus = "proposal" | "live" | "mixed";
export type TrainingLanguage = "en" | "es";

export interface TrainingChapter {
  seconds: number;
  title: string;
  status: TrainingChapterStatus;
}

export interface TrainingVideo {
  id: string;
  slug: TrainingSlug;
  title: string;
  minRole: TrainingFloor;
  language: TrainingLanguage;
  /** Anything the database did not literally call 'live' reads as proposal. */
  contentStatus: "proposal" | "live";
  version: number;
  durationSeconds: number;
  videoPath: string;
  captionsPath: string | null;
  posterPath: string | null;
  transcript: string | null;
  chapters: TrainingChapter[];
  publishedAt: string;
}

/** How long a signed link lives. Long enough for a normal sitting (seeking
 * re-requests byte ranges on the same link), short enough that a forwarded
 * link is dead by the end of the day. Documented as a bearer token. */
export const SIGNED_URL_SECONDS = 3600;

/** Named columns, never `*` — the table does not grant created_at to crews,
 * so a wildcard is refused by design (the same rule as PROFILE_COLS). */
export const TRAINING_VIDEO_COLS =
  "id,slug,title,min_role,language,content_status,version,duration_seconds,video_path,captions_path,poster_path,transcript_text,chapters,published_at,active";

const FLOOR_FOR_SLUG: Record<TrainingSlug, TrainingFloor> = {
  installer: "installer",
  foreman: "foreman",
  leadership: "supervisor",
};

const FLOOR_RANK: Record<TrainingFloor, number> = { installer: 0, foreman: 1, supervisor: 2 };

/**
 * The crew ladder, KNOWN ROLES ONLY. PURE — unit-tested.
 *
 * Unlike roleRank() in install/types.ts, an unknown or missing role is null
 * here rather than the installer floor: somebody whose role this app does not
 * recognise is not somebody to show internal previews to. Mirrors
 * can_watch_app_training() in the migration.
 */
export function trainingRoleRank(role: string | null | undefined): number | null {
  switch (role) {
    case "installer":
      return 0;
    case "foreman":
    case "lead":
      return 1;
    case "supervisor":
    case "admin":
      return 2;
    case "owner":
    case "big_boss":
      return 3;
    default:
      return null;
  }
}

/** May somebody of this role see a walkthrough with this floor? PURE. */
export function canWatchFloor(floor: TrainingFloor, role: string | null | undefined): boolean {
  const rank = trainingRoleRank(role);
  return rank !== null && rank >= FLOOR_RANK[floor];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A chapter list the player can seek through without a second thought, or
 * null. PURE — unit-tested. Same rules as app_training_chapters_valid(): 1–60
 * entries, first at 0, whole seconds, strictly increasing, inside the video, a
 * short title, one of three statuses. A row the database let through will
 * pass; this is here so a hand-edited or older row cannot put a broken list
 * on a phone.
 */
export function parseChapters(raw: unknown, durationSeconds: number): TrainingChapter[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 60) return null;
  const out: TrainingChapter[] = [];
  let prev = -1;
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item)) return null;
    const { seconds, title, status } = item;
    if (typeof seconds !== "number" || !Number.isInteger(seconds)) return null;
    if (i === 0 && seconds !== 0) return null;
    if (seconds <= prev || seconds >= durationSeconds) return null;
    if (typeof title !== "string") return null;
    const clean = title.trim();
    if (clean.length < 1 || clean.length > 120) return null;
    if (status !== "proposal" && status !== "live" && status !== "mixed") return null;
    out.push({ seconds, title: clean, status });
    prev = seconds;
  }
  return out;
}

const SLUGS = new Set<string>(["installer", "foreman", "leadership"]);

function pathOk(path: unknown, prefix: string, ext: RegExp): path is string {
  if (typeof path !== "string" || !path.startsWith(prefix)) return false;
  const file = path.slice(prefix.length);
  return /^[a-z0-9][a-z0-9._-]{0,119}$/.test(file) && ext.test(file);
}

/**
 * One catalog row → a walkthrough the screen can trust, or null. PURE —
 * unit-tested.
 *
 * Refuses anything the migration's checks would refuse (unknown slug, a floor
 * that does not match its slug, a path outside <slug>/<lang>/v<version>/, a
 * bad chapter list), plus rows that are not switched on and published. A bad
 * row disappears from the shelf rather than taking the shelf down with it.
 */
export function parseTrainingVideo(raw: unknown): TrainingVideo | null {
  if (!isRecord(raw)) return null;
  const { id, slug, title, min_role, language, content_status, version, duration_seconds } = raw;
  if (typeof id !== "string" || !id) return null;
  if (typeof slug !== "string" || !SLUGS.has(slug)) return null;
  const s = slug as TrainingSlug;
  if (min_role !== FLOOR_FOR_SLUG[s]) return null;
  if (language !== "en" && language !== "es") return null;
  if (typeof title !== "string" || !title.trim()) return null;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  if (typeof duration_seconds !== "number" || !Number.isInteger(duration_seconds) || duration_seconds < 1) return null;
  if (raw.active !== true) return null;
  if (typeof raw.published_at !== "string" || !raw.published_at) return null;

  const prefix = `${s}/${language}/v${version}/`;
  if (!pathOk(raw.video_path, prefix, /\.mp4$/)) return null;
  const captions = raw.captions_path ?? null;
  if (captions !== null && !pathOk(captions, prefix, /\.vtt$/)) return null;
  const poster = raw.poster_path ?? null;
  if (poster !== null && !pathOk(poster, prefix, /\.(jpg|jpeg|png|webp)$/)) return null;

  const chapters = parseChapters(raw.chapters, duration_seconds);
  if (!chapters) return null;
  const transcript = typeof raw.transcript_text === "string" && raw.transcript_text.trim()
    ? raw.transcript_text
    : null;

  return {
    id,
    slug: s,
    title: title.trim(),
    minRole: FLOOR_FOR_SLUG[s],
    language,
    contentStatus: content_status === "live" ? "live" : "proposal",
    version,
    durationSeconds: duration_seconds,
    videoPath: raw.video_path as string,
    captionsPath: captions as string | null,
    posterPath: poster as string | null,
    transcript,
    chapters,
    publishedAt: raw.published_at,
  };
}

/**
 * What this screen shows, for the role it is rendering as. PURE —
 * unit-tested. Pass the EFFECTIVE role: the server has already applied the
 * real one, and this can only narrow. Ordered by floor (installer first), so
 * everybody reads their own walkthrough and the ones below it in the same
 * order.
 */
export function visibleTrainingVideos(
  videos: TrainingVideo[],
  effectiveRole: string | null | undefined,
): TrainingVideo[] {
  return videos
    .filter((v) => canWatchFloor(v.minRole, effectiveRole))
    .sort((a, b) => FLOOR_RANK[a.minRole] - FLOOR_RANK[b.minRole] || a.title.localeCompare(b.title));
}

/** Does this walkthrough need the design-preview warning? Everything but a
 * video the catalog explicitly calls live does. PURE. */
export function isDesignPreview(video: Pick<TrainingVideo, "contentStatus">): boolean {
  return video.contentStatus !== "live";
}

/** The chapter playing at `seconds`: the last one that has started. PURE. */
export function chapterIndexAt(chapters: TrainingChapter[], seconds: number): number {
  let idx = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].seconds <= seconds) idx = i;
    else break;
  }
  return idx;
}

/** 0:05, 12:40, 1:02:03. PURE. */
export function formatClock(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** A caption file worth handing to <track>: a WebVTT header (optionally after
 * a byte-order mark). PURE. */
export function looksLikeWebVtt(text: string): boolean {
  return /^﻿?WEBVTT(?:[ \t][^\n]*)?\r?(\n|$)/.test(text);
}

/**
 * Every walkthrough the signed-in person may read. A database that has not had
 * the migration yet answers with an empty shelf, not an error — the screen
 * says "nothing published yet", which is the truth from where it stands.
 */
export async function listTrainingVideos(): Promise<TrainingVideo[]> {
  const { data, error } = await supabase
    .from("app_training_videos")
    .select(TRAINING_VIDEO_COLS)
    .eq("active", true)
    .order("slug", { ascending: true });
  if (error) {
    if (isMissingTable(error, "app_training_videos")) return [];
    throw error;
  }
  return ((data ?? []) as unknown[])
    .map(parseTrainingVideo)
    .filter((v): v is TrainingVideo => v !== null);
}

export interface TrainingMedia {
  videoUrl: string;
  /** A blob: URL of the fetched captions, or null when there are none or they
   * failed — the video still plays, and the transcript has the same words. */
  captionsUrl: string | null;
  captionsFailed: boolean;
  posterUrl: string | null;
}

/** How long signing may take before the player says so and offers Retry. */
export const SIGN_TIMEOUT_MS = 30_000;
/** How long the OPTIONAL captions may take — headers and body together —
 * before the video plays without them. */
export const CAPTIONS_TIMEOUT_MS = 15_000;
/** A caption file bigger than this is not a caption file. */
export const CAPTIONS_MAX_BYTES = 1024 * 1024;

export class TrainingTimeoutError extends Error {
  constructor(what: string) {
    super(`${what} took too long.`);
    this.name = "TrainingTimeoutError";
  }
}

/**
 * `work`, or a rejection after `ms` — whichever comes first. The deadline is
 * the promise's own, so it holds even when whatever `work` is waiting on
 * ignores its abort signal (a stalled body read, a client with no signal
 * option). `onTimeout` runs once, for aborting the underlying request. The
 * timer is always cleared. PURE apart from the timer — unit-tested.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new TrainingTimeoutError(what));
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Rejects as soon as `signal` aborts (or at once if it already has). */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export type FetchCaptions = (url: string, signal: AbortSignal) => Promise<string>;

export interface SignOptions {
  /** Aborted when the player gives up: account switch, new video, unmount. */
  signal?: AbortSignal;
  signTimeoutMs?: number;
  captionsTimeoutMs?: number;
  captionsMaxBytes?: number;
}

/**
 * Sign one walkthrough's files for an hour. Storage only signs an object the
 * caller may SELECT, so this is the server's role check a second time.
 *
 * BOUNDED, BOTH HALVES. Signing gets SIGN_TIMEOUT_MS and then fails with a
 * Retry. The captions are optional, so they get CAPTIONS_TIMEOUT_MS for
 * headers and body together and then the video plays WITHOUT them (the
 * transcript has the same words) — a stalled caption file must never hold a
 * playable video hostage. A caption answer that arrives after its deadline,
 * or after `signal` aborts, is dropped without ever becoming a blob.
 *
 * The captions are handed to <track> as a blob: URL rather than as the signed
 * link. A cross-origin <track> needs the <video> itself to be crossOrigin, and
 * a CORS hiccup on that attribute stops the VIDEO loading, not just the
 * captions. The caller owns the blob URL and must revoke it.
 */
export async function signTrainingMedia(
  video: Pick<TrainingVideo, "videoPath" | "captionsPath" | "posterPath">,
  fetchCaptions: FetchCaptions = defaultFetchCaptions,
  opts: SignOptions = {},
): Promise<TrainingMedia> {
  const { signal } = opts;
  const maxBytes = opts.captionsMaxBytes ?? CAPTIONS_MAX_BYTES;
  const paths = [video.videoPath, video.captionsPath, video.posterPath].filter(
    (p): p is string => typeof p === "string",
  );
  const { data, error } = await abortable(
    withDeadline(
      supabase.storage.from(APP_TRAINING_BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS),
      opts.signTimeoutMs ?? SIGN_TIMEOUT_MS,
      "Opening the video",
    ),
    signal,
  );
  if (error) throw error;
  const urlFor = (p: string | null) =>
    p ? (data ?? []).find((d) => d.path === p && !d.error && d.signedUrl)?.signedUrl ?? null : null;

  const videoUrl = urlFor(video.videoPath);
  if (!videoUrl) throw new Error("This walkthrough's video could not be opened.");

  let captionsUrl: string | null = null;
  let captionsFailed = false;
  const captionsSigned = urlFor(video.captionsPath);
  if (video.captionsPath) {
    const controller = new AbortController();
    const forward = () => controller.abort();
    signal?.addEventListener("abort", forward, { once: true });
    try {
      if (!captionsSigned) throw new Error("captions not signed");
      const text = await abortable(
        withDeadline(
          fetchCaptions(captionsSigned, controller.signal),
          opts.captionsTimeoutMs ?? CAPTIONS_TIMEOUT_MS,
          "Loading captions",
          () => controller.abort(),
        ),
        signal,
      );
      if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("captions too large");
      if (!looksLikeWebVtt(text)) throw new Error("not WebVTT");
      if (signal?.aborted || controller.signal.aborted) throw new Error("abandoned");
      captionsUrl = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
    } catch {
      captionsFailed = true;
    } finally {
      signal?.removeEventListener("abort", forward);
    }
  }
  // Abandoned while the captions were in flight: nothing to hand back.
  if (signal?.aborted) {
    if (captionsUrl) URL.revokeObjectURL(captionsUrl);
    throw new DOMException("Aborted", "AbortError");
  }
  return { videoUrl, captionsUrl, captionsFailed, posterUrl: urlFor(video.posterPath) };
}

/**
 * The real caption download: abortable, never from any cache, and refused past
 * CAPTIONS_MAX_BYTES — by Content-Length when the server says, and by counting
 * while reading when it does not.
 */
export async function defaultFetchCaptions(
  url: string,
  signal: AbortSignal,
  maxBytes: number = CAPTIONS_MAX_BYTES,
): Promise<string> {
  // no-store: a caption file is private media too, and the HTTP cache is a
  // cache like any other.
  const res = await fetch(url, { cache: "no-store", credentials: "omit", signal });
  if (!res.ok) throw new Error(`captions ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("captions too large");
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("captions too large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("captions too large");
      chunks.push(value);
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}
