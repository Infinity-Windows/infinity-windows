// The "Using Forge" walkthrough IMPORTER's logic (2026-09-23): read a reviewed
// role-videos-manifest.json and the files it names from this computer, prove
// them sound BEFORE anything leaves it, then reserve → upload → publish through
// the ordinary signed-in session. docs/role-training-importer.md is the
// runbook; supabase/migrations/20261025010000_app_training_importer.sql is the
// lock. Nothing here is trusted by the server — every check is repeated there —
// but a bad file caught here never costs a 45 MB upload.
//
// NEVER A FALSE "PUBLISHED". The outcome is "published" only when the publish
// call itself answered with the rows it switched on. A timeout, a lost answer,
// a cancelled upload or a changed account ends in an error that says nothing
// was published, and a retry resumes the SAME reservation (same versions, same
// paths) rather than starting new ones.
//
// ONE PERSON PER RUN. The actor is captured when Publish is tapped, and the
// session is read again before every server call; a different or absent
// account stops the run, so person A's import can never go out on person B's
// token.
//
// PURE where it can be: the parsers and checks below take plain values and are
// unit-tested; the orchestrator takes its network as an argument.

import { looksLikeWebVtt, parseChapters, type TrainingChapter, type TrainingSlug, type TrainingFloor } from "./appTraining";
import { APP_TRAINING_BUCKET } from "./privateMedia";
import { isMissingFunction } from "./schemaErrors";

// ---------------------------------------------------------------------------
// Limits (the server repeats every one)
// ---------------------------------------------------------------------------
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_VIDEO_BYTES = 47_185_920; // 45 MiB — asset-contract.json
export const MAX_CAPTIONS_BYTES = 1_048_576;
export const MAX_TRANSCRIPT_BYTES = 1_048_576;
export const MAX_POSTER_BYTES = 5_242_880;
export const MAX_TRANSCRIPT_CHARS = 200_000;
export const MAX_DURATION_SECONDS = 7200;
/** How far the file's own length may drift from the manifest's durationSeconds. */
export const DURATION_TOLERANCE_SECONDS = 2;
export const RPC_DEADLINE_MS = 30_000;

const FLOOR_FOR_SLUG: Record<TrainingSlug, TrainingFloor> = {
  installer: "installer",
  foreman: "foreman",
  leadership: "supervisor",
};
export const IMPORT_SLUGS: readonly TrainingSlug[] = ["installer", "foreman", "leadership"];

/** Roles that may SEE the importer. The server decides who may USE it, from
 * the real profile; this only keeps the panel off screens it cannot work on
 * (and off an owner's "view as installer" preview). PURE. */
export function canSeeImporter(effectiveRole: string | null | undefined): boolean {
  return effectiveRole === "supervisor" || effectiveRole === "admin" ||
    effectiveRole === "owner" || effectiveRole === "big_boss";
}

// ---------------------------------------------------------------------------
// Problems — codes, not sentences, so the screen can say them in either language
// ---------------------------------------------------------------------------
export type ImportProblemCode =
  | "manifest.notJson"
  | "manifest.tooLarge"
  | "manifest.shape"
  | "manifest.empty"
  | "manifest.tooMany"
  | "entry.notObject"
  | "entry.unknownField"
  | "entry.field"
  | "entry.slug"
  | "entry.floor"
  | "entry.language"
  | "entry.status"
  | "entry.duration"
  | "entry.version"
  | "entry.chapters"
  | "entry.duplicate"
  | "file.unsafePath"
  | "file.missing"
  | "file.ambiguous"
  | "file.reused"
  | "file.extension"
  | "file.empty"
  | "file.tooLarge"
  | "file.unreadable"
  | "video.notMp4"
  | "video.duration"
  | "video.unreadable"
  | "captions.notVtt"
  | "captions.noCues"
  | "captions.timing"
  | "poster.notImage"
  | "poster.typeMismatch"
  | "transcript.notJson"
  | "transcript.shape"
  | "transcript.language"
  | "transcript.segment"
  | "transcript.order"
  | "transcript.tooLong";

export interface ImportProblem {
  code: ImportProblemCode;
  /** Which walkthrough (entry index + 1 when the slug itself is unusable). */
  where?: string;
  /** A field or file name — shown verbatim, never interpreted. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// 1. The manifest
// ---------------------------------------------------------------------------
export interface ManifestEntry {
  slug: TrainingSlug;
  title: string;
  minRole: TrainingFloor;
  language: "en";
  contentStatus: "proposal";
  durationSeconds: number;
  /** Null: the server allocates the next free version. */
  version: number | null;
  videoFile: string;
  captionsFile: string;
  transcriptFile: string;
  posterFile: string | null;
  chapters: TrainingChapter[];
}

const ENTRY_KEYS = new Set([
  "slug", "title", "minRole", "language", "contentStatus", "durationSeconds", "version",
  "videoFile", "captionsFile", "transcriptFile", "posterFile", "chapters",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A manifest-relative file name that can only mean a file the person picked:
 * no URL, no absolute or drive path, no backslash, no `..` or `.` segment, no
 * empty segment, no query/fragment, no control character. PURE.
 */
export function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length < 1 || p.length > 200) return false;
  if (p !== p.trim()) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:?#%*"<>|]/.test(p)) return false;
  if (p.startsWith("/") || p.startsWith("~")) return false;
  return p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/**
 * role-videos-manifest.json → entries, or every problem found. PURE.
 *
 * The documented shape is `{ "videos": [ … ] }`. A bare array of the same
 * entries is accepted too (it is what the video tooling may write); nothing
 * else is guessed at. Every entry must be valid for ANY to import — a manifest
 * with one bad row is sent back whole, never imported in part.
 */
export function parseImportManifest(
  raw: unknown,
): { ok: true; entries: ManifestEntry[] } | { ok: false; problems: ImportProblem[] } {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.videos) ? raw.videos : null;
  if (!list) return { ok: false, problems: [{ code: "manifest.shape" }] };
  if (list.length === 0) return { ok: false, problems: [{ code: "manifest.empty" }] };
  if (list.length > IMPORT_SLUGS.length) return { ok: false, problems: [{ code: "manifest.tooMany" }] };

  const problems: ImportProblem[] = [];
  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const where = isRecord(item) && typeof item.slug === "string" && IMPORT_SLUGS.includes(item.slug as TrainingSlug)
      ? item.slug
      : `#${i + 1}`;
    const add = (code: ImportProblemCode, detail?: string) => problems.push({ code, where, detail });
    if (!isRecord(item)) return add("entry.notObject");
    const before = problems.length;

    for (const k of Object.keys(item)) if (!ENTRY_KEYS.has(k)) add("entry.unknownField", k);

    const { slug, minRole, title, language, contentStatus, durationSeconds, version, chapters } = item;
    if (typeof slug !== "string" || !IMPORT_SLUGS.includes(slug as TrainingSlug)) add("entry.slug");
    else {
      if (seen.has(slug)) add("entry.duplicate");
      seen.add(slug);
      if (minRole !== FLOOR_FOR_SLUG[slug as TrainingSlug]) add("entry.floor");
    }
    if (typeof title !== "string" || title.trim().length < 1 || title.trim().length > 160) add("entry.field", "title");
    if (language !== "en") add("entry.language");
    if (contentStatus !== "proposal") add("entry.status");
    const durationOk = typeof durationSeconds === "number" && Number.isInteger(durationSeconds) &&
      durationSeconds >= 1 && durationSeconds <= MAX_DURATION_SECONDS;
    if (!durationOk) add("entry.duration");
    if (version !== undefined && version !== null &&
        !(typeof version === "number" && Number.isInteger(version) && version >= 1 && version <= 999)) {
      add("entry.version");
    }
    const parsedChapters = durationOk ? parseChapters(chapters, durationSeconds as number) : null;
    // parseChapters trims titles; the server stores exactly what is sent, so
    // send the checked list rather than the raw one.
    if (durationOk && !parsedChapters) add("entry.chapters");
    if (Array.isArray(chapters) && chapters.some((c) => isRecord(c) && Object.keys(c).some((k) => !["seconds", "title", "status"].includes(k)))) {
      add("entry.chapters");
    }

    for (const field of ["videoFile", "captionsFile", "transcriptFile"] as const) {
      if (!isSafeRelativePath(item[field])) add("file.unsafePath", field);
    }
    if (item.posterFile !== undefined && item.posterFile !== null && !isSafeRelativePath(item.posterFile)) {
      add("file.unsafePath", "posterFile");
    }
    if (isSafeRelativePath(item.videoFile) && !/\.mp4$/i.test(item.videoFile)) add("file.extension", item.videoFile);
    if (isSafeRelativePath(item.captionsFile) && !/\.vtt$/i.test(item.captionsFile)) add("file.extension", item.captionsFile);
    if (isSafeRelativePath(item.transcriptFile) && !/\.json$/i.test(item.transcriptFile)) add("file.extension", item.transcriptFile);
    if (isSafeRelativePath(item.posterFile) && !/\.(jpe?g|png|webp)$/i.test(item.posterFile)) add("file.extension", item.posterFile);

    if (problems.length > before) return;
    entries.push({
      slug: slug as TrainingSlug,
      title: (title as string).trim(),
      minRole: FLOOR_FOR_SLUG[slug as TrainingSlug],
      language: "en",
      contentStatus: "proposal",
      durationSeconds: durationSeconds as number,
      version: typeof version === "number" ? version : null,
      videoFile: item.videoFile as string,
      captionsFile: item.captionsFile as string,
      transcriptFile: item.transcriptFile as string,
      posterFile: typeof item.posterFile === "string" ? item.posterFile : null,
      chapters: parsedChapters as TrainingChapter[],
    });
  });
  return problems.length ? { ok: false, problems } : { ok: true, entries: sortBySlug(entries) };
}

function sortBySlug<T extends { slug: TrainingSlug }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => IMPORT_SLUGS.indexOf(a.slug) - IMPORT_SLUGS.indexOf(b.slug));
}

// ---------------------------------------------------------------------------
// 2. Matching manifest names to the files the person picked
// ---------------------------------------------------------------------------
export interface PickedFile {
  name: string;
  size: number;
  /** Set when a whole folder was picked; "folder/sub/name.ext". */
  webkitRelativePath?: string;
}

/**
 * The one picked file a manifest path names, or why not. PURE.
 *
 * By file name first; when two picked files share a name, the one whose
 * folder path ends with the manifest's path wins, and if that still is not
 * exactly one the answer is "ambiguous" — never a guess.
 */
export function matchPickedFile<F extends PickedFile>(
  manifestPath: string,
  picked: readonly F[],
): { ok: true; file: F } | { ok: false; code: "file.missing" | "file.ambiguous" } {
  const base = manifestPath.split("/").pop() as string;
  const byName = picked.filter((f) => f.name === base);
  if (byName.length === 1) return { ok: true, file: byName[0] };
  if (byName.length === 0) return { ok: false, code: "file.missing" };
  const byPath = byName.filter((f) => {
    const rel = f.webkitRelativePath ?? "";
    return rel === manifestPath || rel.endsWith(`/${manifestPath}`);
  });
  return byPath.length === 1 ? { ok: true, file: byPath[0] } : { ok: false, code: "file.ambiguous" };
}

// ---------------------------------------------------------------------------
// 3. What is actually inside each file
// ---------------------------------------------------------------------------
/** An ISO-BMFF ('ftyp' box at byte 4) file — what every .mp4 starts with. PURE. */
export function looksLikeMp4(head: Uint8Array): boolean {
  return head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
}

export type PosterMime = "image/jpeg" | "image/png" | "image/webp";

/** The poster's real type from its first bytes, or null. PURE. */
export function posterMimeFromBytes(head: Uint8Array): PosterMime | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) return "image/png";
  if (head.length >= 12 && String.fromCharCode(...head.slice(0, 4)) === "RIFF" && String.fromCharCode(...head.slice(8, 12)) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function posterMimeFromName(name: string): PosterMime | null {
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  return null;
}

function vttSeconds(stamp: string): number | null {
  const m = /^(?:(\d{1,3}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(stamp);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/**
 * A caption file the player can use for THIS video: a WebVTT header, at least
 * one cue with words in it, every cue's times well-formed, start before end,
 * and inside the video. PURE.
 */
export function checkWebVtt(
  text: string,
  durationSeconds: number,
): { ok: true; cues: number } | { ok: false; code: "captions.notVtt" | "captions.noCues" | "captions.timing" } {
  if (!looksLikeWebVtt(text)) return { ok: false, code: "captions.notVtt" };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cues = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("-->")) continue;
    const [left, right] = lines[i].split("-->");
    const start = vttSeconds(left.trim());
    const end = vttSeconds((right ?? "").trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || start >= end || end > durationSeconds + DURATION_TOLERANCE_SECONDS) {
      return { ok: false, code: "captions.timing" };
    }
    if ((lines[i + 1] ?? "").trim()) cues++;
  }
  return cues > 0 ? { ok: true, cues } : { ok: false, code: "captions.noCues" };
}

/**
 * The transcript JSON → the plain text the catalog stores, one paragraph per
 * segment, every word kept. PURE.
 *
 * `{ language, segments: [{ startSeconds, endSeconds, text }] }`: numbers
 * finite, 0 ≤ start < end ≤ the video (plus a rounding second or two), starts
 * in order, text non-empty. The original file stays where it is on this
 * computer — the database keeps the words, not the timings.
 */
export function flattenTranscript(
  raw: unknown,
  language: string,
  durationSeconds: number,
): { ok: true; text: string; segments: number } | { ok: false; code: ImportProblemCode; detail?: string } {
  if (!isRecord(raw) || !Array.isArray(raw.segments)) return { ok: false, code: "transcript.shape" };
  if (raw.language !== language) return { ok: false, code: "transcript.language" };
  if (raw.segments.length < 1 || raw.segments.length > 10_000) return { ok: false, code: "transcript.shape" };
  const paras: string[] = [];
  let prevStart = -Infinity;
  for (const [i, seg] of raw.segments.entries()) {
    const where = String(i + 1);
    if (!isRecord(seg)) return { ok: false, code: "transcript.segment", detail: where };
    const { startSeconds, endSeconds, text } = seg;
    if (typeof startSeconds !== "number" || typeof endSeconds !== "number" ||
        !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) ||
        startSeconds < 0 || endSeconds <= startSeconds ||
        endSeconds > durationSeconds + DURATION_TOLERANCE_SECONDS) {
      return { ok: false, code: "transcript.segment", detail: where };
    }
    if (typeof text !== "string" || !text.trim()) return { ok: false, code: "transcript.segment", detail: where };
    if (startSeconds < prevStart) return { ok: false, code: "transcript.order", detail: where };
    prevStart = startSeconds;
    paras.push(text.trim());
  }
  const out = paras.join("\n\n");
  if (out.length > MAX_TRANSCRIPT_CHARS) return { ok: false, code: "transcript.tooLong" };
  return { ok: true, text: out, segments: paras.length };
}

/** Does the file's own length agree with the manifest? PURE. */
export function durationAgrees(probedSeconds: number | null, declared: number): boolean {
  return probedSeconds !== null && Number.isFinite(probedSeconds) &&
    Math.abs(probedSeconds - declared) <= DURATION_TOLERANCE_SECONDS;
}

// ---------------------------------------------------------------------------
// 4. Prepare: manifest + picked files → a plan, or every problem
// ---------------------------------------------------------------------------
export type AssetKind = "video" | "captions" | "poster";

export interface PlannedAsset {
  kind: AssetKind;
  file: File;
  bytes: number;
  mime: string;
  sha256: string;
}

export interface PlannedWalkthrough {
  slug: TrainingSlug;
  minRole: TrainingFloor;
  language: "en";
  title: string;
  durationSeconds: number;
  version: number | null;
  chapters: TrainingChapter[];
  transcriptText: string;
  transcriptSegments: number;
  captionCues: number;
  assets: PlannedAsset[];
}

export interface PrepareDeps {
  sha256: (file: File) => Promise<string>;
  /** The video's own length in seconds, or null if this browser cannot read it. */
  probeDuration: (file: File) => Promise<number | null>;
}

async function head(file: File, n = 16): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, n).arrayBuffer());
}

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Everything checked before a single byte is uploaded: the manifest, that each
 * name matches exactly one picked file and no file is used twice, sizes, what
 * each file really is, captions and transcript against the video's length,
 * and the video's own length against the manifest. All problems are returned
 * together so the person can fix them in one pass.
 */
export async function prepareImport(
  manifestFile: File,
  picked: readonly File[],
  deps: PrepareDeps,
): Promise<{ ok: true; plan: PlannedWalkthrough[] } | { ok: false; problems: ImportProblem[] }> {
  if (manifestFile.size > MAX_MANIFEST_BYTES) return { ok: false, problems: [{ code: "manifest.tooLarge" }] };
  let raw: unknown;
  try {
    raw = JSON.parse(await manifestFile.text());
  } catch {
    return { ok: false, problems: [{ code: "manifest.notJson" }] };
  }
  const parsed = parseImportManifest(raw);
  if (!parsed.ok) return parsed;

  const problems: ImportProblem[] = [];
  const used = new Map<File, string>();
  const plan: PlannedWalkthrough[] = [];

  for (const e of parsed.entries) {
    const where = e.slug;
    const before = problems.length;
    const pick = (name: string): File | null => {
      const m = matchPickedFile(name, picked);
      if (!m.ok) {
        problems.push({ code: m.code, where, detail: name });
        return null;
      }
      const prior = used.get(m.file);
      if (prior !== undefined) {
        problems.push({ code: "file.reused", where, detail: name });
        return null;
      }
      used.set(m.file, name);
      return m.file;
    };
    const video = pick(e.videoFile);
    const captions = pick(e.captionsFile);
    const transcript = pick(e.transcriptFile);
    const poster = e.posterFile ? pick(e.posterFile) : null;

    const sized = (f: File | null, max: number): f is File => {
      if (!f) return false;
      if (f.size < 1) problems.push({ code: "file.empty", where, detail: f.name });
      else if (f.size > max) problems.push({ code: "file.tooLarge", where, detail: f.name });
      else return true;
      return false;
    };

    let posterMime: PosterMime | null = null;
    let captionCues = 0;
    let transcriptText = "";
    let transcriptSegments = 0;
    try {
      if (sized(video, MAX_VIDEO_BYTES)) {
        if (!looksLikeMp4(await head(video))) problems.push({ code: "video.notMp4", where, detail: video.name });
        else {
          const probed = await deps.probeDuration(video);
          if (probed === null) problems.push({ code: "video.unreadable", where, detail: video.name });
          else if (!durationAgrees(probed, e.durationSeconds)) {
            problems.push({ code: "video.duration", where, detail: `${Math.round(probed)}` });
          }
        }
      }
      if (sized(captions, MAX_CAPTIONS_BYTES)) {
        const vtt = checkWebVtt(await captions.text(), e.durationSeconds);
        if (!vtt.ok) problems.push({ code: vtt.code, where, detail: captions.name });
        else captionCues = vtt.cues;
      }
      if (sized(transcript, MAX_TRANSCRIPT_BYTES)) {
        let json: unknown;
        try {
          json = JSON.parse(await transcript.text());
        } catch {
          problems.push({ code: "transcript.notJson", where, detail: transcript.name });
        }
        if (json !== undefined) {
          const flat = flattenTranscript(json, e.language, e.durationSeconds);
          if (!flat.ok) problems.push({ code: flat.code, where, detail: flat.detail });
          else {
            transcriptText = flat.text;
            transcriptSegments = flat.segments;
          }
        }
      }
      if (sized(poster, MAX_POSTER_BYTES)) {
        posterMime = posterMimeFromBytes(await head(poster));
        if (!posterMime) problems.push({ code: "poster.notImage", where, detail: poster.name });
        else if (posterMime !== posterMimeFromName(poster.name)) {
          problems.push({ code: "poster.typeMismatch", where, detail: poster.name });
        }
      }
    } catch {
      problems.push({ code: "file.unreadable", where });
    }
    if (problems.length > before || !video || !captions) continue;

    const assets: PlannedAsset[] = [
      { kind: "video", file: video, bytes: video.size, mime: "video/mp4", sha256: await deps.sha256(video) },
      { kind: "captions", file: captions, bytes: captions.size, mime: "text/vtt", sha256: await deps.sha256(captions) },
    ];
    if (poster && posterMime) {
      assets.push({ kind: "poster", file: poster, bytes: poster.size, mime: posterMime, sha256: await deps.sha256(poster) });
    }
    plan.push({
      slug: e.slug,
      minRole: e.minRole,
      language: e.language,
      title: e.title,
      durationSeconds: e.durationSeconds,
      version: e.version,
      chapters: e.chapters,
      transcriptText,
      transcriptSegments,
      captionCues,
      assets,
    });
  }
  return problems.length ? { ok: false, problems } : { ok: true, plan };
}

/** The reservation request, exactly the keys the server accepts. PURE. */
export function reservePayload(w: PlannedWalkthrough): Record<string, unknown> {
  const a = (kind: AssetKind) => {
    const x = w.assets.find((y) => y.kind === kind);
    return x ? { bytes: x.bytes, sha256: x.sha256, mime: x.mime } : null;
  };
  return {
    slug: w.slug,
    minRole: w.minRole,
    language: w.language,
    contentStatus: "proposal",
    title: w.title,
    durationSeconds: w.durationSeconds,
    chapters: w.chapters,
    transcriptText: w.transcriptText,
    version: w.version,
    video: a("video"),
    captions: a("captions"),
    poster: a("poster"),
  };
}

// ---------------------------------------------------------------------------
// 5. What the server answers, checked rather than trusted
// ---------------------------------------------------------------------------
export interface ReservedAsset {
  kind: AssetKind;
  path: string;
  bytes: number;
  mime: string;
}

export interface Reservation {
  id: string;
  slug: TrainingSlug;
  language: "en";
  version: number;
  state: "reserved" | "published" | "cancelled";
  expiresAt: string;
  assets: ReservedAsset[];
}

export interface StoredAsset extends ReservedAsset {
  present: boolean;
  ownedByYou: boolean;
  storedBytes: number | null;
  storedMime: string | null;
}

export interface PublishedWalkthrough {
  id: string;
  slug: TrainingSlug;
  version: number;
  active: boolean;
  alreadyPublished: boolean;
}

const PATH_FILE = /^[a-z0-9][a-z0-9._-]{0,119}$/;

/**
 * A reservation that matches what was asked for: the right walkthrough,
 * paths inside its own <slug>/<lang>/v<version>/, and the same byte counts and
 * types as the planned files. Anything else is treated as a broken answer.
 * PURE.
 */
export function parseReservation(raw: unknown, w: PlannedWalkthrough): Reservation | null {
  if (!isRecord(raw)) return null;
  const { id, slug, language, version, state, expiresAt, assets } = raw;
  if (typeof id !== "string" || !id || slug !== w.slug || language !== w.language) return null;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  if (w.version !== null && version !== w.version) return null;
  if (state !== "reserved" && state !== "published" && state !== "cancelled") return null;
  if (typeof expiresAt !== "string" || !Array.isArray(assets) || assets.length !== w.assets.length) return null;
  const prefix = `${w.slug}/${w.language}/v${version}/`;
  const out: ReservedAsset[] = [];
  for (const planned of w.assets) {
    const a = assets.find((x) => isRecord(x) && x.kind === planned.kind);
    if (!isRecord(a) || typeof a.path !== "string" || !a.path.startsWith(prefix)) return null;
    if (!PATH_FILE.test(a.path.slice(prefix.length))) return null;
    if (a.bytes !== planned.bytes || a.mime !== planned.mime) return null;
    out.push({ kind: planned.kind, path: a.path, bytes: planned.bytes, mime: planned.mime });
  }
  return { id, slug: w.slug, language: w.language, version, state, expiresAt, assets: out };
}

export function parseStatus(raw: unknown, r: Reservation): { expired: boolean; state: Reservation["state"]; assets: StoredAsset[] } | null {
  if (!Array.isArray(raw)) return null;
  const row = raw.find((x) => isRecord(x) && x.id === r.id);
  if (!isRecord(row) || !Array.isArray(row.assets)) return null;
  const state = row.state;
  if (state !== "reserved" && state !== "published" && state !== "cancelled") return null;
  const assets: StoredAsset[] = [];
  for (const want of r.assets) {
    const a = row.assets.find((x) => isRecord(x) && x.path === want.path);
    if (!isRecord(a)) return null;
    assets.push({
      ...want,
      present: a.present === true,
      ownedByYou: a.ownedByYou === true,
      storedBytes: typeof a.storedBytes === "number" ? a.storedBytes : null,
      storedMime: typeof a.storedMime === "string" ? a.storedMime : null,
    });
  }
  return { expired: row.expired === true, state, assets };
}

/** Storage's RECORD agrees: stored by this account, same byte COUNT, same
 * type. Not proof of the same bytes — an object found already there (a retry,
 * a 409) must also pass a content digest before it is accepted. PURE. */
export function storedMatches(a: StoredAsset): boolean {
  return a.present && a.ownedByYou && a.storedBytes === a.bytes && a.storedMime === a.mime;
}

export function parsePublishResult(raw: unknown, reservations: readonly Reservation[]): PublishedWalkthrough[] | null {
  if (!Array.isArray(raw) || raw.length !== reservations.length) return null;
  const out: PublishedWalkthrough[] = [];
  for (const r of reservations) {
    const row = raw.find((x) => isRecord(x) && x.id === r.id);
    if (!isRecord(row) || row.slug !== r.slug || row.version !== r.version || typeof row.active !== "boolean") return null;
    out.push({ id: r.id, slug: r.slug, version: r.version, active: row.active, alreadyPublished: row.alreadyPublished === true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 6. Errors the screen can explain
// ---------------------------------------------------------------------------
export type ImportErrorCode =
  | "signedOut"
  | "accountChanged"
  | "cancelled"
  | "timeout"
  | "network"
  | "notInstalled"
  | "notAllowed"
  | "rejected"
  | "versionTaken"
  | "requestChanged"
  | "expired"
  | "cancelledServer"
  | "missing"
  | "mismatch"
  | "newerPublished"
  | "notFound"
  | "tooLarge"
  | "badResponse"
  | "server";

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly slug?: string;
  constructor(code: ImportErrorCode, slug?: string) {
    super(`training import: ${code}${slug ? ` (${slug})` : ""}`);
    this.name = "ImportError";
    this.code = code;
    this.slug = slug;
  }
}

/** Errors after which the SAME reservation can never publish: start over with
 * a new request (new versions). Everything else retries the same one. PURE. */
export function needsFreshStart(code: ImportErrorCode): boolean {
  return code === "expired" || code === "cancelledServer" || code === "requestChanged" ||
    code === "mismatch" || code === "newerPublished" || code === "versionTaken";
}

/** A server/RPC error → a code. Reads the `hint` the migration sets. PURE. */
export function importErrorFromServer(err: unknown): ImportError {
  if (err instanceof ImportError) return err;
  if (isMissingFunction(err)) return new ImportError("notInstalled");
  const rec = isRecord(err) ? err : {};
  const hint = typeof rec.hint === "string" ? rec.hint : "";
  const code = typeof rec.code === "string" ? rec.code : "";
  if (hint === "not_allowed" || code === "42501") return new ImportError("notAllowed");
  if (hint === "expired") return new ImportError("expired");
  if (hint === "cancelled") return new ImportError("cancelledServer");
  if (hint === "newer_published") return new ImportError("newerPublished");
  if (hint === "request_changed") return new ImportError("requestChanged");
  if (hint === "version_taken") return new ImportError("versionTaken");
  if (hint === "not_found") return new ImportError("notFound");
  if (hint.startsWith("missing_")) return new ImportError("missing");
  if (hint.startsWith("mismatch_")) return new ImportError("mismatch");
  if (hint.startsWith("too_large_")) return new ImportError("tooLarge");
  if (hint.startsWith("invalid_")) return new ImportError("rejected");
  const msg = err instanceof Error ? err.message : typeof rec.message === "string" ? rec.message : "";
  if (err instanceof TypeError || /failed to fetch|network|load failed|timed out/i.test(msg)) {
    return new ImportError("network");
  }
  return new ImportError("server");
}

// ---------------------------------------------------------------------------
// 7. Deadlines and the upload itself
// ---------------------------------------------------------------------------
/**
 * Settle `work` within `ms` or reject with a timeout — whether or not the
 * thing underneath honours its abort. `onTimeout` is told so it can abort.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new ImportError("timeout"));
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Two minutes, plus a second for every 128 KiB — a slow office line still
 * finishes a 45 MB file; a dead one is abandoned in minutes, not forever. PURE. */
export function uploadDeadlineMs(bytes: number): number {
  return Math.min(15 * 60_000, 120_000 + Math.ceil(bytes / 131_072) * 1000);
}

export interface UploadRequest {
  path: string;
  file: Blob;
  contentType: string;
  accessToken: string;
  signal: AbortSignal;
  onProgress: (loaded: number, total: number) => void;
}

/** ok, or the HTTP status storage answered with (409: something is already there). */
export type UploadResult = { ok: true } | { ok: false; status: number };

/** Storage's object URL for a path, each segment encoded. PURE. */
export function storageObjectUrl(baseUrl: string, path: string): string {
  const enc = path.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl.replace(/\/+$/, "")}/storage/v1/object/${APP_TRAINING_BUCKET}/${enc}`;
}

/**
 * A native authenticated storage upload over XMLHttpRequest — the one browser
 * API that reports upload progress and can be aborted. The same request
 * supabase-js makes (POST, x-upsert: false), with the caller's OWN access
 * token passed in per request rather than read from a shared client, and a
 * no-store cache header so a private file is never kept by a CDN or browser.
 * The caller bounds it with withDeadline.
 */
export function createXhrUploader(
  baseUrl: string,
  anonKey: string,
  makeXhr: () => XMLHttpRequest = () => new XMLHttpRequest(),
): (req: UploadRequest) => Promise<UploadResult> {
  return (req) =>
    new Promise<UploadResult>((resolve, reject) => {
      const xhr = makeXhr();
      const onAbort = () => xhr.abort();
      if (req.signal.aborted) return reject(new ImportError("cancelled"));
      req.signal.addEventListener("abort", onAbort, { once: true });
      const done = () => req.signal.removeEventListener("abort", onAbort);
      xhr.open("POST", storageObjectUrl(baseUrl, req.path));
      xhr.setRequestHeader("authorization", `Bearer ${req.accessToken}`);
      xhr.setRequestHeader("apikey", anonKey);
      xhr.setRequestHeader("x-upsert", "false");
      xhr.setRequestHeader("content-type", req.contentType);
      xhr.setRequestHeader("cache-control", "no-store");
      xhr.upload.onprogress = (ev) => req.onProgress(ev.loaded, ev.lengthComputable ? ev.total : req.file.size);
      xhr.onload = () => {
        done();
        resolve(xhr.status >= 200 && xhr.status < 300 ? { ok: true } : { ok: false, status: storageStatus(xhr) });
      };
      xhr.onerror = () => {
        done();
        reject(new ImportError("network"));
      };
      xhr.onabort = () => {
        done();
        reject(new ImportError("cancelled"));
      };
      xhr.send(req.file);
    });
}

/** Storage answers some refusals as HTTP 400 with the real status in the
 * body ({"statusCode":"409","error":"Duplicate"}). PURE-ish. */
function storageStatus(xhr: XMLHttpRequest): number {
  try {
    const body = JSON.parse(xhr.responseText) as { statusCode?: unknown };
    const n = Number(body.statusCode);
    if (Number.isInteger(n) && n >= 400) return n;
  } catch {
    /* not JSON: the HTTP status is all there is */
  }
  return xhr.status;
}

// ---------------------------------------------------------------------------
// 8. Token-bound transports: RPC and reading a stored object back
// ---------------------------------------------------------------------------
// Neither goes through the shared Supabase client. That client attaches
// WHOEVER is signed in at the moment the request leaves, so an account switch
// between "check who this is" and "send" would carry person B's token on
// person A's import. These take the token captured for the actor, per call,
// and never log it.

export interface RpcRequest {
  fn: string;
  args: Record<string, unknown>;
  accessToken: string;
  signal: AbortSignal;
}

export type RpcResult = { data: unknown; error: unknown };

/** PostgREST `POST /rest/v1/rpc/<fn>` with an explicit bearer token. The
 * body is read inside the caller's deadline and abort. */
export function createFetchRpc(
  baseUrl: string,
  anonKey: string,
  fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a),
): (req: RpcRequest) => Promise<RpcResult> {
  return async ({ fn, args, accessToken, signal }) => {
    if (!/^[a-z_]+$/.test(fn)) throw new ImportError("badResponse");
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
      credentials: "omit",
      signal,
    });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: `HTTP ${res.status}` };
      }
    }
    if (!res.ok) return { data: null, error: isRecord(body) ? body : { message: `HTTP ${res.status}` } };
    return { data: body, error: null };
  };
}

export interface DigestRequest {
  path: string;
  accessToken: string;
  signal: AbortSignal;
  /** Stop reading past this: it cannot be the planned file. */
  maxBytes: number;
}

/**
 * SHA-256 of an object as storage serves it to THIS account
 * (`/object/authenticated/…`, which the staged-read policy allows only for the
 * uploader's own reservations). Streamed with a byte ceiling; no link is
 * minted, nothing is cached (no-store; the service worker already leaves this
 * bucket alone — lib/privateMedia.ts).
 */
export function createStoredDigest(
  baseUrl: string,
  anonKey: string,
  fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a),
): (req: DigestRequest) => Promise<string> {
  return async ({ path, accessToken, signal, maxBytes }) => {
    const enc = path.split("/").map(encodeURIComponent).join("/");
    const res = await fetchImpl(
      `${baseUrl.replace(/\/+$/, "")}/storage/v1/object/authenticated/${APP_TRAINING_BUCKET}/${enc}`,
      {
        method: "GET",
        headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },
        cache: "no-store",
        credentials: "omit",
        signal,
      },
    );
    if (!res.ok) throw new ImportError(res.status === 401 || res.status === 403 ? "notAllowed" : "server");
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new ImportError("mismatch");
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new ImportError("mismatch");
        }
        chunks.push(value);
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      total = buf.byteLength;
      if (total > maxBytes) throw new ImportError("mismatch");
      chunks.push(buf);
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    const digest = await crypto.subtle.digest("SHA-256", all);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  };
}

// ---------------------------------------------------------------------------
// 9. The run: reserve → upload → verify → publish
// ---------------------------------------------------------------------------
export interface ImportSession {
  /** One per prepared plan, kept across retries so the server answers with
   * the same reservations instead of new versions. */
  requestId: string;
  reservations: Reservation[];
}

export type AssetProgressState = "waiting" | "uploading" | "stored" | "failed";

export interface AssetProgress {
  slug: TrainingSlug;
  kind: AssetKind;
  loaded: number;
  total: number;
  state: AssetProgressState;
}

export type ImportStep = "reserving" | "uploading" | "verifying" | "publishing";

export interface ImportProgress {
  step: ImportStep;
  /** Keyed by reserved object path. */
  assets: Record<string, AssetProgress>;
}

export interface ImportDeps {
  /** Must use req.accessToken and nothing else for identity. */
  rpc: (req: RpcRequest) => Promise<RpcResult>;
  /** Who is signed in right now, read fresh (supabase.auth.getSession). */
  getSession: () => Promise<{ userId: string; accessToken: string } | null>;
  upload: (req: UploadRequest) => Promise<UploadResult>;
  storedSha256: (req: DigestRequest) => Promise<string>;
  rpcDeadlineMs?: number;
  sessionDeadlineMs?: number;
  uploadDeadline?: (bytes: number) => number;
}

export const SESSION_DEADLINE_MS = 10_000;

export interface RunOptions {
  actorId: string;
  signal: AbortSignal;
  onProgress: (p: ImportProgress) => void;
  /** Called as soon as reservations exist, so a retry can reuse them. */
  onSession: (s: ImportSession) => void;
}

/** The pieces every server step shares: is this still the same person, and
 * a call bound to that person's token with its own deadline and abort. */
function actorGuard(deps: Pick<ImportDeps, "getSession" | "rpc" | "rpcDeadlineMs" | "sessionDeadlineMs">, actorId: string, signal: AbortSignal) {
  const alive = () => {
    if (signal.aborted) throw new ImportError("cancelled");
  };
  // Before and after EVERY server call. The token returned is the one the
  // next request carries — never one captured earlier for somebody else.
  const actor = async () => {
    alive();
    const s = await withDeadline(deps.getSession(), deps.sessionDeadlineMs ?? SESSION_DEADLINE_MS);
    alive();
    if (!s) throw new ImportError("signedOut");
    if (s.userId !== actorId) throw new ImportError("accountChanged");
    return s;
  };
  /** Run `work` with a fresh abort (linked to the run's) and a deadline that
   * covers the whole response, then confirm the actor again. */
  const bounded = async <T>(ms: number, work: (token: string, signal: AbortSignal) => Promise<T>): Promise<T> => {
    const s = await actor();
    const ctl = new AbortController();
    const forward = () => ctl.abort();
    signal.addEventListener("abort", forward, { once: true });
    let out: T;
    try {
      out = await withDeadline(work(s.accessToken, ctl.signal), ms, () => ctl.abort());
    } catch (err) {
      alive();
      throw err instanceof ImportError ? err : importErrorFromServer(err);
    } finally {
      signal.removeEventListener("abort", forward);
    }
    alive();
    // The answer arrived — but is it still this person's screen? A switch
    // while it was in flight means nothing more is done with it.
    await actor();
    return out;
  };
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const res = await bounded(deps.rpcDeadlineMs ?? RPC_DEADLINE_MS, (accessToken, sig) =>
      deps.rpc({ fn, args, accessToken, signal: sig }),
    );
    if (res.error) throw importErrorFromServer(res.error);
    return res.data;
  };
  return { alive, actor, bounded, call };
}

/**
 * Publish a prepared plan as the person who tapped Publish. Resolves ONLY
 * with the rows the publish call confirmed; every other ending throws an
 * ImportError — which does NOT mean nothing was published: a publish that
 * committed and then lost its answer is still published, and calling this
 * again with the returned session says so (alreadyPublished) without
 * publishing twice. Reservations come back the same, and files already stored
 * and proven ours are not sent again.
 */
export async function runImport(
  plan: readonly PlannedWalkthrough[],
  session: ImportSession,
  deps: ImportDeps,
  opts: RunOptions,
): Promise<PublishedWalkthrough[]> {
  const { signal } = opts;
  const uploadMs = deps.uploadDeadline ?? uploadDeadlineMs;
  const { alive, bounded, call } = actorGuard(deps, opts.actorId, signal);

  const progress: ImportProgress = { step: "reserving", assets: {} };
  const emit = () => {
    if (!signal.aborted) opts.onProgress({ step: progress.step, assets: { ...progress.assets } });
  };
  emit();

  // 1. Reserve (or get the same reservations back).
  const reservations: Reservation[] = [];
  for (const w of plan) {
    const data = await call("app_training_import_reserve", { p_request_id: session.requestId, p_entry: reservePayload(w) });
    const r = parseReservation(data, w);
    if (!r) throw new ImportError("badResponse", w.slug);
    if (r.state === "cancelled") throw new ImportError("cancelledServer", w.slug);
    reservations.push(r);
    for (const a of r.assets) {
      progress.assets[a.path] ??= { slug: r.slug, kind: a.kind, loaded: 0, total: a.bytes, state: "waiting" };
    }
  }
  alive();
  opts.onSession({ requestId: session.requestId, reservations });
  emit();

  const planned = (r: Reservation, kind: AssetKind) =>
    ((plan.find((p) => p.slug === r.slug) as PlannedWalkthrough).assets.find((a) => a.kind === kind) as PlannedAsset);

  // Paths whose content is PROVEN to be the planned file: uploaded by this
  // run and answered 200, or read back and digested.
  const proven = new Set<string>();
  const proveByDigest = async (r: Reservation, a: StoredAsset) => {
    if (!storedMatches(a)) throw new ImportError("mismatch", r.slug);
    const digest = await bounded(uploadMs(a.bytes), (accessToken, sig) =>
      deps.storedSha256({ path: a.path, accessToken, signal: sig, maxBytes: a.bytes }),
    );
    if (digest !== planned(r, a.kind).sha256) throw new ImportError("mismatch", r.slug);
    proven.add(a.path);
  };

  const ids = reservations.map((r) => r.id);
  const readStatus = async () => {
    const data = await call("app_training_import_status", { p_ids: ids });
    return reservations.map((r) => {
      const s = parseStatus(data, r);
      if (!s) throw new ImportError("badResponse", r.slug);
      if (s.state === "cancelled") throw new ImportError("cancelledServer", r.slug);
      if (s.expired) throw new ImportError("expired", r.slug);
      return { r, s };
    });
  };

  // 2. Upload whatever is not already there — and prove what is there is ours.
  progress.step = "uploading";
  emit();
  for (const { r, s } of await readStatus()) {
    if (s.state === "published") {
      for (const a of r.assets) progress.assets[a.path] = { ...progress.assets[a.path], loaded: a.bytes, state: "stored" };
      continue;
    }
    for (const stored of s.assets) {
      if (stored.present) {
        // Something is already at our reserved path (a retry after a lost
        // answer). Same owner, count and type is not enough: read it back.
        await proveByDigest(r, stored);
        progress.assets[stored.path] = { ...progress.assets[stored.path], loaded: stored.bytes, state: "stored" };
        emit();
        continue;
      }
      const file = planned(r, stored.kind).file;
      progress.assets[stored.path] = { ...progress.assets[stored.path], loaded: 0, state: "uploading" };
      emit();
      let result: UploadResult;
      try {
        result = await bounded(uploadMs(stored.bytes), (accessToken, sig) =>
          deps.upload({
            path: stored.path,
            file,
            contentType: stored.mime,
            accessToken,
            signal: sig,
            onProgress: (loaded, total) => {
              if (signal.aborted) return;
              progress.assets[stored.path] = { ...progress.assets[stored.path], loaded, total };
              emit();
            },
          }),
        );
      } catch (err) {
        progress.assets[stored.path] = { ...progress.assets[stored.path], state: "failed" };
        emit();
        throw err;
      }
      if (!result.ok && result.status !== 409) {
        progress.assets[stored.path] = { ...progress.assets[stored.path], state: "failed" };
        emit();
        throw new ImportError(
          result.status === 401 || result.status === 403 ? "notAllowed" : result.status === 413 ? "tooLarge" : "server",
          r.slug,
        );
      }
      // A 409 is NOT success: the object there is digested below like any
      // other object this run did not itself store.
      if (result.ok) proven.add(stored.path);
      progress.assets[stored.path] = { ...progress.assets[stored.path], loaded: stored.bytes, state: result.ok ? "stored" : "waiting" };
      emit();
    }
  }

  // 3. Verify every object from storage's own record.
  progress.step = "verifying";
  emit();
  for (const { r, s } of await readStatus()) {
    if (s.state === "published") continue;
    for (const a of s.assets) {
      if (!a.present) throw new ImportError("missing", r.slug);
      if (!storedMatches(a)) throw new ImportError("mismatch", r.slug);
      if (!proven.has(a.path)) await proveByDigest(r, a);
      progress.assets[a.path] = { ...progress.assets[a.path], loaded: a.bytes, state: "stored" };
    }
  }
  emit();

  // 4. Publish. Only this answer is success.
  progress.step = "publishing";
  emit();
  const data = await call("app_training_import_publish", { p_ids: ids });
  const published = parsePublishResult(data, reservations);
  if (!published) throw new ImportError("badResponse");
  return published;
}

export interface CancelOutcome {
  /** Reservations whose upload door is now closed. */
  cancelled: TrainingSlug[];
  /** Reservations that had ALREADY been published — they stay published. */
  published: { slug: TrainingSlug; version: number }[];
}

/** Give up this person's reservations that are not yet published. Nothing
 * uploaded is deleted and no published walkthrough is touched; the server's
 * answer says which ones were in fact already published. */
export async function cancelReservations(
  session: ImportSession,
  actorId: string,
  deps: Pick<ImportDeps, "rpc" | "getSession" | "rpcDeadlineMs" | "sessionDeadlineMs">,
  signal: AbortSignal = new AbortController().signal,
): Promise<CancelOutcome> {
  const { call } = actorGuard(deps, actorId, signal);
  const out: CancelOutcome = { cancelled: [], published: [] };
  for (const r of session.reservations) {
    let data: unknown;
    try {
      data = await call("app_training_import_cancel", { p_id: r.id });
    } catch (err) {
      if (err instanceof ImportError && err.code === "notFound") continue;
      throw err;
    }
    const state = isRecord(data) ? data.state : null;
    if (state === "published") out.published.push({ slug: r.slug, version: r.version });
    else if (state === "cancelled") out.cancelled.push(r.slug);
    else throw new ImportError("badResponse", r.slug);
  }
  return out;
}
