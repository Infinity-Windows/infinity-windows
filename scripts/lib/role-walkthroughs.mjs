// The rules a reviewed "Using Forge" package must pass. Validation only:
// publication goes through the owner's in-app importer, which checks
// everything again on the server. Pure apart from reading the files it is
// pointed at, so the test (scripts/publish-role-walkthroughs.test.mjs) can
// drive it with a temp folder and no network. The CLI is scripts/publish-role-walkthroughs.mjs; the runbook
// is docs/role-training-videos.md.
//
// These mirror the database's own checks (20261025000000) on purpose: a
// manifest this passes is one the catalog will accept, and a manifest it fails
// is refused on the laptop, before a single byte leaves it.

import { lstatSync, openSync, readSync, closeSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";

export const BUCKET = "app-training";

/** Each walkthrough's floor, pinned to its slug — the same pairs the table's
 * check constraint allows. */
export const FLOOR_FOR_SLUG = Object.freeze({
  installer: "installer",
  foreman: "foreman",
  leadership: "supervisor",
});

export const LIMITS = Object.freeze({
  // The bucket's own ceiling. The project's global upload limit may be lower;
  // the runbook says where to check it.
  videoBytes: 45 * 1024 * 1024,
  captionsBytes: 1024 * 1024,
  posterBytes: 5 * 1024 * 1024,
  transcriptChars: 200_000,
  maxDurationSeconds: 7200,
  maxChapters: 60,
});

const CONTENT_TYPE = {
  ".mp4": "video/mp4",
  ".vtt": "text/vtt",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json",
};

/** The package's manifest is `{ version?, videos: [...] }` — nothing else. */
export function manifestEntries(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  return Array.isArray(manifest.videos) ? manifest.videos : null;
}

const TRANSCRIPT_KEYS = new Set(["language", "voice", "contentStatus", "title", "segments"]);
const SEGMENT_KEYS = new Set(["startSeconds", "endSeconds", "text"]);

/**
 * The walkthrough package's transcript JSON (its assemble.py):
 *   { language, voice?, contentStatus?, title?, segments: [{ startSeconds, endSeconds, text }] }
 * Returns `{ errors, text }`. `text` keeps EVERY segment's words, verbatim and
 * in order: segments that run on from each other (the caption chunks of one
 * scene) join with a space, and a pause between them starts a new paragraph,
 * which is where the player's transcript breaks its lines.
 */
export function parseTranscriptJson(raw, { language, durationSeconds }) {
  const errors = [];
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { errors: ["transcript is not valid JSON"], text: null };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { errors: ["transcript must be an object"], text: null };
  for (const k of Object.keys(doc)) if (!TRANSCRIPT_KEYS.has(k)) errors.push(`transcript has an unexpected field '${k}'`);
  if (doc.language !== language) errors.push(`transcript language '${doc.language}' does not match the entry's '${language}'`);
  if (doc.contentStatus !== undefined && doc.contentStatus !== "proposal") errors.push("transcript contentStatus must be 'proposal'");
  if (!Array.isArray(doc.segments) || doc.segments.length === 0) {
    errors.push("transcript must have a non-empty segments list");
    return { errors, text: null };
  }
  let prevStart = -1;
  let prevEnd = null;
  let text = "";
  doc.segments.forEach((seg, i) => {
    const at = `transcript segment ${i + 1}`;
    if (!seg || typeof seg !== "object" || Array.isArray(seg)) return errors.push(`${at} is not an object`);
    for (const k of Object.keys(seg)) if (!SEGMENT_KEYS.has(k)) errors.push(`${at} has an unexpected field '${k}'`);
    const { startSeconds: a, endSeconds: b, text: words } = seg;
    const okA = typeof a === "number" && Number.isFinite(a) && a >= 0;
    const okB = typeof b === "number" && Number.isFinite(b) && okA && b > a;
    if (!okA) errors.push(`${at}: startSeconds must be a number of seconds, 0 or more`);
    if (!okB) errors.push(`${at}: endSeconds must be after startSeconds`);
    if (okA && a < prevStart) errors.push(`${at}: segments must be in time order`);
    if (okB && Number.isInteger(durationSeconds) && b > durationSeconds + 2) {
      errors.push(`${at}: ends at ${b}s, past the end of a ${durationSeconds}s video`);
    }
    if (typeof words !== "string" || !words.trim()) return errors.push(`${at}: text must not be empty`);
    if (!okA || !okB) return;
    text += prevEnd === null ? words : a - prevEnd > 0.3 ? `\n\n${words}` : ` ${words}`;
    prevStart = a;
    prevEnd = b;
  });
  return { errors, text: errors.length ? null : text };
}

/**
 * Contact details that must never ride along in a transcript or a caption:
 * an email address or a US-shaped phone number. Crude on purpose — a false
 * alarm costs a reviewer a minute; a miss publishes somebody's number.
 */
export function privateDataHits(text) {
  const hits = [];
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) hits.push("an email address");
  if (/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/.test(text)) hits.push("a phone number");
  return hits;
}

/** Seconds from a WebVTT timestamp ("01:02.500" or "1:01:02.500"). */
function vttSeconds(stamp) {
  const parts = stamp.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** The last cue's end time, or NaN if there are no cues. */
export function lastCueEnd(vtt) {
  let last = NaN;
  for (const m of vtt.matchAll(/-->\s*((?:\d+:)?\d{2}:\d{2}\.\d{3})/g)) {
    const s = vttSeconds(m[1]);
    if (!(s <= last)) last = s;
  }
  return last;
}

export function validateChapters(chapters, durationSeconds) {
  const errors = [];
  if (!Array.isArray(chapters) || chapters.length < 1) return ["chapters must be a non-empty list"];
  if (chapters.length > LIMITS.maxChapters) errors.push(`at most ${LIMITS.maxChapters} chapters`);
  let prev = -1;
  chapters.forEach((c, i) => {
    const at = `chapter ${i + 1}`;
    if (!c || typeof c !== "object") return errors.push(`${at} is not an object`);
    if (!Number.isInteger(c.seconds)) errors.push(`${at}: seconds must be a whole number`);
    else {
      if (i === 0 && c.seconds !== 0) errors.push(`${at}: the first chapter starts at 0`);
      if (c.seconds <= prev) errors.push(`${at}: chapters must be in order, no two at the same second`);
      if (c.seconds >= durationSeconds) errors.push(`${at}: starts at ${c.seconds}s, past the end of a ${durationSeconds}s video`);
      prev = c.seconds;
    }
    const title = typeof c.title === "string" ? c.title.trim() : "";
    if (title.length < 1 || title.length > 120) errors.push(`${at}: title must be 1–120 characters`);
    if (!["proposal", "live", "mixed"].includes(c.status)) {
      errors.push(`${at}: status must be proposal, live or mixed`);
    }
  });
  return errors;
}

function head(path, n) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function sniff(ext, bytes) {
  if (ext === ".mp4") return bytes.length >= 8 && bytes.subarray(4, 8).toString("latin1") === "ftyp";
  if (ext === ".jpg" || ext === ".jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (ext === ".png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === ".webp") {
    return bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  }
  return true;
}

/**
 * Resolve one file named by the manifest, refusing anything that is not a
 * plain file INSIDE the manifest's folder: no absolute paths, no `..`, no
 * symlink pointing out, nothing that is not a regular file.
 */
function resolveFile(baseDir, rel, label, allowed, maxBytes, errors) {
  if (typeof rel !== "string" || !rel.trim()) {
    errors.push(`${label}: missing`);
    return null;
  }
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    errors.push(`${label}: must be a path inside the manifest's folder (${rel})`);
    return null;
  }
  const ext = extname(rel).toLowerCase();
  if (!allowed.includes(ext)) {
    errors.push(`${label}: must be ${allowed.join(" or ")} (${rel})`);
    return null;
  }
  const full = resolve(baseDir, rel);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    errors.push(`${label}: not found (${rel})`);
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    errors.push(`${label}: must be a regular file, not a link or folder (${rel})`);
    return null;
  }
  const realBase = realpathSync(baseDir);
  const real = realpathSync(full);
  if (!real.startsWith(realBase + sep)) {
    errors.push(`${label}: resolves outside the manifest's folder (${rel})`);
    return null;
  }
  if (stat.size === 0) errors.push(`${label}: is empty (${rel})`);
  if (maxBytes != null && stat.size > maxBytes) {
    errors.push(`${label}: ${stat.size} bytes is over the ${maxBytes}-byte limit (${rel})`);
  }
  if (!sniff(ext, head(full, 16))) errors.push(`${label}: contents are not a real ${ext} file (${rel})`);
  return { full, rel, ext, size: stat.size, contentType: CONTENT_TYPE[ext] ?? "text/plain" };
}

/**
 * Check a whole manifest. Returns `{ errors, plan }`; publish only when
 * `errors` is empty. `plan` has one entry per walkthrough with the catalog row
 * to insert and the uploads to make.
 */
export function validateManifest(manifest, { baseDir, version = 1, limits = LIMITS } = {}) {
  const errors = [];
  const plan = [];
  const entries = manifestEntries(manifest);
  if (!entries) return { errors: ["manifest must be an object with a `videos` list"], plan };
  if (entries.length === 0) return { errors: ["manifest lists no walkthroughs"], plan };
  const seen = new Set();

  entries.forEach((e, i) => {
    const errs = [];
    const where = `entry ${i + 1}${e && typeof e.slug === "string" ? ` (${e.slug})` : ""}`;
    if (!e || typeof e !== "object") {
      errors.push(`${where}: not an object`);
      return;
    }
    const slug = e.slug;
    if (!Object.hasOwn(FLOOR_FOR_SLUG, slug)) errs.push("slug must be installer, foreman or leadership");
    else if (seen.has(slug)) errs.push("slug listed twice");
    else seen.add(slug);
    if (Object.hasOwn(FLOOR_FOR_SLUG, slug) && e.minRole !== FLOOR_FOR_SLUG[slug]) {
      errs.push(`minRole for ${slug} must be exactly '${FLOOR_FOR_SLUG[slug]}' (got '${e.minRole}')`);
    }
    if (e.language !== "en" && e.language !== "es") errs.push("language must be 'en' or 'es'");
    if (e.contentStatus !== "proposal") {
      errs.push("contentStatus must be 'proposal' — these walkthroughs show proposed designs");
    }
    const v = e.version ?? version;
    if (!Number.isInteger(v) || v < 1 || v > 999) errs.push("version must be a whole number 1–999");
    const title = typeof e.title === "string" ? e.title.trim() : "";
    if (title.length < 1 || title.length > 160) errs.push("title must be 1–160 characters");
    const d = e.durationSeconds;
    if (!Number.isInteger(d) || d < 1 || d > limits.maxDurationSeconds) {
      errs.push(`durationSeconds must be a whole number 1–${limits.maxDurationSeconds}`);
    }
    if (Number.isInteger(d)) errs.push(...validateChapters(e.chapters, d));

    const video = resolveFile(baseDir, e.videoFile, "videoFile", [".mp4"], limits.videoBytes, errs);
    const captions = resolveFile(baseDir, e.captionsFile, "captionsFile", [".vtt"], limits.captionsBytes, errs);
    const transcriptFile = resolveFile(baseDir, e.transcriptFile, "transcriptFile", [".json"], 4 * 1024 * 1024, errs);
    const poster = e.posterFile == null
      ? null
      : resolveFile(baseDir, e.posterFile, "posterFile", [".jpg", ".jpeg", ".png", ".webp"], limits.posterBytes, errs);

    let transcript = null;
    if (transcriptFile) {
      const raw = readFileSync(transcriptFile.full, "utf8");
      if (raw.includes("\uFFFD")) errs.push("transcriptFile is not valid UTF-8");
      const parsed = parseTranscriptJson(raw, { language: e.language, durationSeconds: d });
      errs.push(...parsed.errors);
      transcript = parsed.text;
      if (transcript !== null) {
        if (transcript.length > limits.transcriptChars) errs.push(`transcript is over ${limits.transcriptChars} characters`);
        for (const hit of privateDataHits(transcript)) errs.push(`transcript contains ${hit} — remove it before publishing`);
      }
    }
    if (captions) {
      const vtt = readFileSync(captions.full, "utf8");
      if (!/^﻿?WEBVTT(?:[ \t][^\n]*)?\r?(\n|$)/.test(vtt)) errs.push("captionsFile does not start with a WEBVTT header");
      const end = lastCueEnd(vtt);
      if (Number.isNaN(end)) errs.push("captionsFile has no cues");
      else if (Number.isInteger(d) && end > d + 2) errs.push(`captions run to ${end}s, past the end of a ${d}s video`);
      for (const hit of privateDataHits(vtt)) errs.push(`captions contain ${hit} — remove it before publishing`);
    }
    for (const c of Array.isArray(e.chapters) ? e.chapters : []) {
      for (const hit of privateDataHits(String(c?.title ?? ""))) errs.push(`a chapter title contains ${hit}`);
    }
    for (const hit of privateDataHits(title)) errs.push(`the title contains ${hit}`);

    if (errs.length) {
      for (const m of errs) errors.push(`${where}: ${m}`);
      return;
    }

    // Fixed object names under a versioned folder: nothing from the laptop's
    // file names reaches the bucket, and v2 can never overwrite v1.
    const prefix = `${slug}/${e.language}/v${v}/`;
    const uploads = [
      { ...video, object: `${prefix}walkthrough.mp4` },
      { ...captions, object: `${prefix}captions.vtt` },
      ...(poster ? [{ ...poster, object: `${prefix}poster${poster.ext === ".jpeg" ? ".jpg" : poster.ext}` }] : []),
    ];
    plan.push({
      slug,
      prefix,
      uploads,
      row: {
        slug,
        title,
        min_role: FLOOR_FOR_SLUG[slug],
        language: e.language,
        content_status: "proposal",
        version: v,
        duration_seconds: d,
        video_path: uploads[0].object,
        captions_path: uploads[1].object,
        poster_path: poster ? uploads[2].object : null,
        transcript_text: transcript,
        chapters: e.chapters.map((c) => ({ seconds: c.seconds, title: c.title.trim(), status: c.status })),
      },
    });
  });

  return { errors, plan };
}
