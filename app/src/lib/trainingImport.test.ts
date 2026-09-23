// The importer's half of the walkthrough lock: what it refuses before a byte
// leaves the computer, what it believes from the server, and that it never
// says "published" until the publish call itself said so. The server's half
// is scripts/verify-app-training-importer.mjs. Every fixture is synthetic.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ImportError,
  MAX_VIDEO_BYTES,
  canSeeImporter,
  cancelReservations,
  createFetchRpc,
  createStoredDigest,
  checkWebVtt,
  createXhrUploader,
  durationAgrees,
  flattenTranscript,
  importErrorFromServer,
  isSafeRelativePath,
  looksLikeMp4,
  matchPickedFile,
  needsFreshStart,
  parseImportManifest,
  parsePublishResult,
  parseReservation,
  posterMimeFromBytes,
  prepareImport,
  reservePayload,
  runImport,
  sha256Hex,
  storageObjectUrl,
  uploadDeadlineMs,
  withDeadline,
  type ImportDeps,
  type ImportProgress,
  type ImportSession,
  type PlannedWalkthrough,
  type UploadRequest,
} from "./trainingImport";

vi.mock("./supabase", () => ({ supabase: {} }));

// ---- synthetic fixtures ----------------------------------------------------
const FLOOR = { installer: "installer", foreman: "foreman", leadership: "supervisor" } as const;
type Slug = keyof typeof FLOOR;

function entry(slug: Slug, extra: Record<string, unknown> = {}) {
  return {
    slug,
    title: `Synthetic ${slug} tour`,
    minRole: FLOOR[slug],
    language: "en",
    contentStatus: "proposal",
    durationSeconds: 120,
    videoFile: `${slug}-tour.mp4`,
    captionsFile: `${slug}-tour.vtt`,
    transcriptFile: `${slug}-transcript.json`,
    posterFile: `${slug}-poster.jpg`,
    chapters: [
      { seconds: 0, title: "Start", status: "live" },
      { seconds: 60, title: "Idea", status: "proposal" },
    ],
    ...extra,
  };
}
const manifest = (...entries: unknown[]) => ({ videos: entries });

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56]);
const VTT = "WEBVTT\n\n00:00.000 --> 00:04.000\nSynthetic caption one.\n\n00:01:00.000 --> 00:01:05.500 align:start\nSynthetic caption two.\n";
const TRANSCRIPT = JSON.stringify({
  language: "en",
  segments: [
    { startSeconds: 0, endSeconds: 4, text: " Synthetic narration one. " },
    { startSeconds: 60, endSeconds: 65.5, text: "Synthetic narration two." },
  ],
});

function filesFor(slug: Slug): File[] {
  return [
    new File([MP4], `${slug}-tour.mp4`, { type: "video/mp4" }),
    new File([VTT], `${slug}-tour.vtt`, { type: "text/vtt" }),
    new File([TRANSCRIPT], `${slug}-transcript.json`, { type: "application/json" }),
    new File([JPEG], `${slug}-poster.jpg`, { type: "image/jpeg" }),
  ];
}
const manifestFile = (m: unknown) => new File([JSON.stringify(m)], "role-videos-manifest.json");
const prepDeps = (probe: number | null = 120) => ({ sha256: sha256Hex, probeDuration: async () => probe });
function withSize(f: File, size: number): File {
  Object.defineProperty(f, "size", { value: size });
  return f;
}

async function planFor(...slugs: Slug[]): Promise<PlannedWalkthrough[]> {
  const res = await prepareImport(manifestFile(manifest(...slugs.map((s) => entry(s)))), slugs.flatMap(filesFor), prepDeps());
  if (!res.ok) throw new Error(JSON.stringify(res.problems));
  return res.plan;
}

// ---- who sees the panel ----------------------------------------------------
describe("canSeeImporter", () => {
  it("shows for supervisor and owner (and aliases), hides for everyone else", () => {
    for (const r of ["supervisor", "admin", "owner", "big_boss"]) expect(canSeeImporter(r)).toBe(true);
    for (const r of ["installer", "foreman", "lead", "contractor", null, undefined, ""]) expect(canSeeImporter(r)).toBe(false);
  });
});

// ---- the manifest ----------------------------------------------------------
describe("parseImportManifest", () => {
  it("accepts the documented {videos:[…]} shape and orders by role floor", () => {
    const res = parseImportManifest(manifest(entry("leadership"), entry("installer"), entry("foreman")));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entries.map((e) => e.slug)).toEqual(["installer", "foreman", "leadership"]);
      expect(res.entries[2].minRole).toBe("supervisor");
      expect(res.entries[0].version).toBeNull();
    }
  });

  it("accepts a bare array of entries and a single walkthrough", () => {
    expect(parseImportManifest([entry("foreman")]).ok).toBe(true);
  });

  it("refuses every other shape rather than guessing", () => {
    for (const raw of [{ items: [entry("installer")] }, {}, null, "x", 3, { videos: "x" }]) {
      expect(parseImportManifest(raw)).toEqual({ ok: false, problems: [{ code: "manifest.shape" }] });
    }
    expect(parseImportManifest({ videos: [] })).toEqual({ ok: false, problems: [{ code: "manifest.empty" }] });
    expect(parseImportManifest([entry("installer"), entry("foreman"), entry("leadership"), entry("installer")]))
      .toEqual({ ok: false, problems: [{ code: "manifest.tooMany" }] });
  });

  const bad: [string, Record<string, unknown>, string][] = [
    ["unknown field", entry("installer", { videoPath: "installer/en/v1/walkthrough.mp4" }), "entry.unknownField"],
    ["missing title", (() => { const e: Record<string, unknown> = entry("installer"); delete e.title; return e; })(), "entry.field"],
    ["null title", entry("installer", { title: null }), "entry.field"],
    ["blank title", entry("installer", { title: "  " }), "entry.field"],
    ["unknown slug", entry("installer", { slug: "helper" }), "entry.slug"],
    ["leadership opened to foremen", entry("leadership", { minRole: "foreman" }), "entry.floor"],
    ["installer walkthrough raised", entry("installer", { minRole: "supervisor" }), "entry.floor"],
    ["Spanish narration claimed", entry("installer", { language: "es" }), "entry.language"],
    ["claims live", entry("installer", { contentStatus: "live" }), "entry.status"],
    ["missing status", entry("installer", { contentStatus: undefined }), "entry.status"],
    ["zero duration", entry("installer", { durationSeconds: 0 }), "entry.duration"],
    ["too long", entry("installer", { durationSeconds: 7201 }), "entry.duration"],
    ["fractional duration", entry("installer", { durationSeconds: 90.5 }), "entry.duration"],
    ["string duration", entry("installer", { durationSeconds: "120" }), "entry.duration"],
    ["version zero", entry("installer", { version: 0 }), "entry.version"],
    ["version string", entry("installer", { version: "2" }), "entry.version"],
    ["chapter without seconds", entry("installer", { chapters: [{ title: "a", status: "live" }] }), "entry.chapters"],
    ["chapter without status", entry("installer", { chapters: [{ seconds: 0, title: "a" }] }), "entry.chapters"],
    ["chapter past the end", entry("installer", { chapters: [{ seconds: 0, title: "a", status: "live" }, { seconds: 120, title: "b", status: "live" }] }), "entry.chapters"],
    ["chapter with a link", entry("installer", { chapters: [{ seconds: 0, title: "a", status: "live", href: "x" }] }), "entry.chapters"],
    ["absolute path", entry("installer", { videoFile: "/Users/someone/installer-tour.mp4" }), "file.unsafePath"],
    ["traversal", entry("installer", { captionsFile: "../installer-tour.vtt" }), "file.unsafePath"],
    ["URL", entry("installer", { videoFile: "https://example.invalid/installer-tour.mp4" }), "file.unsafePath"],
    ["missing transcript", entry("installer", { transcriptFile: undefined }), "file.unsafePath"],
    ["video not mp4", entry("installer", { videoFile: "installer-tour.mov" }), "file.extension"],
    ["poster gif", entry("installer", { posterFile: "installer-poster.gif" }), "file.extension"],
  ];
  it.each(bad)("refuses %s", (_why, e, code) => {
    const res = parseImportManifest(manifest(e));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problems.map((p) => p.code)).toContain(code);
  });

  it("sends back a whole manifest when any one row is bad", () => {
    const res = parseImportManifest(manifest(entry("installer"), entry("foreman", { contentStatus: "live" })));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problems).toEqual([{ code: "entry.status", where: "foreman" }]);
  });

  it("refuses the same walkthrough twice", () => {
    const res = parseImportManifest(manifest(entry("installer"), entry("installer", { title: "Again" })));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problems.map((p) => p.code)).toContain("entry.duplicate");
  });

  it("keeps a requested version and an absent poster", () => {
    const res = parseImportManifest(manifest(entry("foreman", { version: 4, posterFile: null })));
    expect(res.ok && res.entries[0]).toMatchObject({ version: 4, posterFile: null });
  });
});

describe("isSafeRelativePath", () => {
  it.each(["a.mp4", "videos/a.mp4", "Role Videos/installer-tour.mp4"])("accepts %s", (p) => {
    expect(isSafeRelativePath(p)).toBe(true);
  });
  it.each([
    "", "/a.mp4", "~/a.mp4", "../a.mp4", "a/../b.mp4", "./a.mp4", "a//b.mp4", "a/", "https://x/a.mp4",
    "C:\\a.mp4", "a\\b.mp4", "a.mp4?x=1", "a.mp4#t", " a.mp4", "%2e%2e/a.mp4", "a\u0000.mp4", "file:a.mp4",
  ])("refuses %j", (p) => {
    expect(isSafeRelativePath(p)).toBe(false);
  });
  it("refuses non-strings and absurd lengths", () => {
    expect(isSafeRelativePath(null)).toBe(false);
    expect(isSafeRelativePath(`${"a".repeat(201)}.mp4`)).toBe(false);
  });
});

describe("matchPickedFile", () => {
  const f = (name: string, rel = "") => ({ name, size: 1, webkitRelativePath: rel });
  it("finds the one file with that name", () => {
    const pick = [f("a.mp4"), f("b.mp4")];
    expect(matchPickedFile("a.mp4", pick)).toEqual({ ok: true, file: pick[0] });
    expect(matchPickedFile("videos/a.mp4", pick)).toEqual({ ok: true, file: pick[0] });
  });
  it("says missing rather than picking something close", () => {
    expect(matchPickedFile("A.mp4", [f("a.mp4")])).toEqual({ ok: false, code: "file.missing" });
  });
  it("uses the folder path to tell same-named files apart, or calls it ambiguous", () => {
    const pick = [f("a.mp4", "drop/v1/a.mp4"), f("a.mp4", "drop/v2/a.mp4")];
    expect(matchPickedFile("v2/a.mp4", pick)).toEqual({ ok: true, file: pick[1] });
    expect(matchPickedFile("a.mp4", pick)).toEqual({ ok: false, code: "file.ambiguous" });
    expect(matchPickedFile("a.mp4", [f("a.mp4"), f("a.mp4")])).toEqual({ ok: false, code: "file.ambiguous" });
  });
});

// ---- inside the files --------------------------------------------------------
describe("file contents", () => {
  it("recognises an mp4 by its ftyp box, not its name", () => {
    expect(looksLikeMp4(MP4)).toBe(true);
    expect(looksLikeMp4(JPEG)).toBe(false);
    expect(looksLikeMp4(new Uint8Array(3))).toBe(false);
  });

  it("reads the poster's real type", () => {
    expect(posterMimeFromBytes(JPEG)).toBe("image/jpeg");
    expect(posterMimeFromBytes(PNG)).toBe("image/png");
    expect(posterMimeFromBytes(WEBP)).toBe("image/webp");
    expect(posterMimeFromBytes(MP4)).toBeNull();
  });

  it("accepts captions with a header and a cue inside the video", () => {
    expect(checkWebVtt(VTT, 120)).toEqual({ ok: true, cues: 2 });
    expect(checkWebVtt(`\uFEFF${VTT}`, 120).ok).toBe(true);
  });
  it.each([
    ["no header", "00:00.000 --> 00:01.000\nHi\n", "captions.notVtt"],
    ["SRT", "1\n00:00:00,000 --> 00:00:01,000\nHi\n", "captions.notVtt"],
    ["header only", "WEBVTT\n\n", "captions.noCues"],
    ["cue with no words", "WEBVTT\n\n00:00.000 --> 00:01.000\n\n", "captions.noCues"],
    ["malformed time", "WEBVTT\n\n0:0.0 --> 00:01.000\nHi\n", "captions.timing"],
    ["ends before it starts", "WEBVTT\n\n00:05.000 --> 00:01.000\nHi\n", "captions.timing"],
    ["runs past the video", "WEBVTT\n\n00:00.000 --> 02:10.000\nHi\n", "captions.timing"],
  ])("refuses captions: %s", (_why, text, code) => {
    expect(checkWebVtt(text, 120)).toEqual({ ok: false, code });
  });

  it("flattens the transcript to paragraphs and keeps every word", () => {
    const res = flattenTranscript(JSON.parse(TRANSCRIPT), "en", 120);
    expect(res).toEqual({ ok: true, text: "Synthetic narration one.\n\nSynthetic narration two.", segments: 2 });
  });
  it.each([
    ["not an object", [], "transcript.shape"],
    ["no segments", { language: "en" }, "transcript.shape"],
    ["empty segments", { language: "en", segments: [] }, "transcript.shape"],
    ["other language", { language: "es", segments: [{ startSeconds: 0, endSeconds: 1, text: "x" }] }, "transcript.language"],
    ["missing language", { segments: [{ startSeconds: 0, endSeconds: 1, text: "x" }] }, "transcript.language"],
    ["infinite end", { language: "en", segments: [{ startSeconds: 0, endSeconds: Infinity, text: "x" }] }, "transcript.segment"],
    ["negative start", { language: "en", segments: [{ startSeconds: -1, endSeconds: 1, text: "x" }] }, "transcript.segment"],
    ["zero length", { language: "en", segments: [{ startSeconds: 3, endSeconds: 3, text: "x" }] }, "transcript.segment"],
    ["past the video", { language: "en", segments: [{ startSeconds: 0, endSeconds: 130, text: "x" }] }, "transcript.segment"],
    ["string time", { language: "en", segments: [{ startSeconds: "0", endSeconds: 1, text: "x" }] }, "transcript.segment"],
    ["blank text", { language: "en", segments: [{ startSeconds: 0, endSeconds: 1, text: " " }] }, "transcript.segment"],
    ["null segment", { language: "en", segments: [null] }, "transcript.segment"],
    ["out of order", { language: "en", segments: [{ startSeconds: 5, endSeconds: 6, text: "a" }, { startSeconds: 1, endSeconds: 2, text: "b" }] }, "transcript.order"],
    ["too long", { language: "en", segments: [{ startSeconds: 0, endSeconds: 1, text: "x".repeat(200_001) }] }, "transcript.tooLong"],
  ])("refuses a transcript: %s", (_why, raw, code) => {
    const res = flattenTranscript(raw, "en", 120);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(code);
  });

  it("compares the video's own length within two seconds", () => {
    expect(durationAgrees(121.9, 120)).toBe(true);
    expect(durationAgrees(122.5, 120)).toBe(false);
    expect(durationAgrees(null, 120)).toBe(false);
    expect(durationAgrees(NaN, 120)).toBe(false);
  });
});

// ---- prepare -----------------------------------------------------------------
describe("prepareImport", () => {
  it("builds a plan with fingerprints, the flattened transcript and the poster's real type", async () => {
    const [w] = await planFor("installer");
    expect(w).toMatchObject({ slug: "installer", minRole: "installer", title: "Synthetic installer tour", captionCues: 2, transcriptSegments: 2 });
    expect(w.assets.map((a) => [a.kind, a.mime, a.bytes])).toEqual([
      ["video", "video/mp4", MP4.length], ["captions", "text/vtt", VTT.length], ["poster", "image/jpeg", JPEG.length],
    ]);
    expect(w.assets[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.assets[0].sha256).toBe(await sha256Hex(new Blob([MP4])));
  });

  it("sends the server exactly the keys it accepts and nothing about paths", async () => {
    const [w] = await planFor("leadership");
    const body = reservePayload(w);
    expect(Object.keys(body).sort()).toEqual([
      "captions", "chapters", "contentStatus", "durationSeconds", "language", "minRole", "poster", "slug", "title", "transcriptText", "version", "video",
    ]);
    expect(body).toMatchObject({ slug: "leadership", minRole: "supervisor", contentStatus: "proposal", version: null });
    expect(JSON.stringify(body)).not.toMatch(/Path|File"/);
  });

  it("imports one walkthrough without the others", async () => {
    expect((await planFor("foreman")).map((w) => w.slug)).toEqual(["foreman"]);
  });

  async function problems(m: unknown, files: File[], probe: number | null = 120) {
    const res = await prepareImport(manifestFile(m), files, prepDeps(probe));
    return res.ok ? [] : res.problems;
  }

  it("refuses a manifest that is not JSON", async () => {
    const res = await prepareImport(new File(["{videos:"], "m.json"), [], prepDeps());
    expect(res).toEqual({ ok: false, problems: [{ code: "manifest.notJson" }] });
  });

  it("names every missing file, all at once", async () => {
    const got = await problems(manifest(entry("installer")), filesFor("installer").slice(0, 1));
    expect(got.map((p) => [p.code, p.detail])).toEqual([
      ["file.missing", "installer-tour.vtt"], ["file.missing", "installer-transcript.json"], ["file.missing", "installer-poster.jpg"],
    ]);
  });

  it("refuses one picked file standing in for two walkthroughs", async () => {
    const m = manifest(entry("installer"), entry("foreman", { captionsFile: "installer-tour.vtt" }));
    const files = [...filesFor("installer"), ...filesFor("foreman").filter((f) => !f.name.endsWith(".vtt"))];
    expect((await problems(m, files)).map((p) => p.code)).toContain("file.reused");
  });

  it("refuses ambiguous same-named picks", async () => {
    const files = [...filesFor("installer"), new File([MP4], "installer-tour.mp4")];
    expect((await problems(manifest(entry("installer")), files)).map((p) => p.code)).toContain("file.ambiguous");
  });

  it("refuses an oversized or empty video before reading it", async () => {
    const big = filesFor("installer");
    big[0] = withSize(big[0], MAX_VIDEO_BYTES + 1);
    expect((await problems(manifest(entry("installer")), big)).map((p) => p.code)).toEqual(["file.tooLarge"]);
    const empty = filesFor("installer");
    empty[0] = new File([], "installer-tour.mp4");
    expect((await problems(manifest(entry("installer")), empty)).map((p) => p.code)).toEqual(["file.empty"]);
  });

  it("refuses a renamed file that is not an mp4", async () => {
    const files = filesFor("installer");
    files[0] = new File([JPEG], "installer-tour.mp4");
    expect((await problems(manifest(entry("installer")), files)).map((p) => p.code)).toEqual(["video.notMp4"]);
  });

  it("refuses a poster whose bytes disagree with its name", async () => {
    const files = filesFor("installer");
    files[3] = new File([PNG], "installer-poster.jpg");
    expect((await problems(manifest(entry("installer")), files)).map((p) => p.code)).toEqual(["poster.typeMismatch"]);
  });

  it("refuses a video whose own length disagrees with the manifest, or cannot be read", async () => {
    expect((await problems(manifest(entry("installer")), filesFor("installer"), 150)).map((p) => [p.code, p.detail]))
      .toEqual([["video.duration", "150"]]);
    expect((await problems(manifest(entry("installer")), filesFor("installer"), null)).map((p) => p.code))
      .toEqual(["video.unreadable"]);
  });

  it("refuses broken captions and transcripts", async () => {
    const files = filesFor("installer");
    files[1] = new File(["00:00.000 --> 00:01.000\nHi"], "installer-tour.vtt");
    files[2] = new File(["not json"], "installer-transcript.json");
    expect((await problems(manifest(entry("installer")), files)).map((p) => p.code)).toEqual(["captions.notVtt", "transcript.notJson"]);
  });

  it("refuses captions timed past a shorter manifest duration", async () => {
    const m = manifest(entry("installer", { durationSeconds: 30, chapters: [{ seconds: 0, title: "a", status: "live" }] }));
    expect((await problems(m, filesFor("installer"), 30)).map((p) => p.code)).toEqual(["captions.timing", "transcript.segment"]);
  });
});

// ---- trusting the server's answers -----------------------------------------------
describe("server answers", () => {
  const reservation = (w: PlannedWalkthrough, version = 2, over: Record<string, unknown> = {}) => ({
    id: `id-${w.slug}`,
    slug: w.slug,
    language: "en",
    version,
    state: "reserved",
    expiresAt: "2026-09-23T18:00:00Z",
    assets: w.assets.map((a) => ({
      kind: a.kind,
      path: `${w.slug}/en/v${version}/${a.kind === "video" ? "walkthrough.mp4" : a.kind === "captions" ? "captions.vtt" : "poster.jpg"}`,
      bytes: a.bytes,
      mime: a.mime,
    })),
    ...over,
  });

  it("accepts a reservation that matches the plan", async () => {
    const [w] = await planFor("installer");
    expect(parseReservation(reservation(w), w)?.assets.map((a) => a.path)).toEqual([
      "installer/en/v2/walkthrough.mp4", "installer/en/v2/captions.vtt", "installer/en/v2/poster.jpg",
    ]);
  });

  it("refuses a reservation that points anywhere else or describes other files", async () => {
    const [w] = await planFor("installer");
    const r = reservation(w);
    const tamper = [
      { ...r, slug: "leadership" },
      { ...r, assets: [{ ...r.assets[0], path: "leadership/en/v2/walkthrough.mp4" }, ...r.assets.slice(1)] },
      { ...r, assets: [{ ...r.assets[0], path: "installer/en/v1/walkthrough.mp4" }, ...r.assets.slice(1)] },
      { ...r, assets: [{ ...r.assets[0], path: "installer/en/v2/../v1/walkthrough.mp4" }, ...r.assets.slice(1)] },
      { ...r, assets: [{ ...r.assets[0], bytes: 1 }, ...r.assets.slice(1)] },
      { ...r, assets: r.assets.slice(1) },
      { ...r, state: "live" },
      { ...r, version: 0 },
    ];
    for (const t of tamper) expect(parseReservation(t, w)).toBeNull();
    expect(parseReservation(r, { ...w, version: 5 })).toBeNull();
  });

  it("only accepts a publish answer naming every reservation", async () => {
    const [w] = await planFor("installer");
    const r = parseReservation(reservation(w), w)!;
    expect(parsePublishResult([{ id: r.id, slug: "installer", version: 2, active: true, alreadyPublished: false }], [r]))
      .toEqual([{ id: r.id, slug: "installer", version: 2, active: true, alreadyPublished: false }]);
    expect(parsePublishResult([], [r])).toBeNull();
    expect(parsePublishResult(null, [r])).toBeNull();
    expect(parsePublishResult([{ id: r.id, slug: "installer", version: 3, active: true }], [r])).toBeNull();
  });

  it("maps the migration's hints to plain codes", () => {
    const cases: [unknown, string][] = [
      [{ code: "42501", hint: "not_allowed" }, "notAllowed"],
      [{ code: "22023", hint: "expired" }, "expired"],
      [{ code: "22023", hint: "cancelled" }, "cancelledServer"],
      [{ code: "22023", hint: "newer_published" }, "newerPublished"],
      [{ code: "22023", hint: "missing_captions" }, "missing"],
      [{ code: "22023", hint: "mismatch_video" }, "mismatch"],
      [{ code: "23505", hint: "version_taken" }, "versionTaken"],
      [{ code: "22023", hint: "request_changed" }, "requestChanged"],
      [{ code: "22023", hint: "invalid_title" }, "rejected"],
      [{ code: "PGRST202", message: "Could not find the function public.app_training_import_reserve" }, "notInstalled"],
      [new TypeError("Failed to fetch"), "network"],
      [{ code: "XX000", message: "boom" }, "server"],
    ];
    for (const [err, code] of cases) expect(importErrorFromServer(err).code).toBe(code);
    expect(needsFreshStart("expired")).toBe(true);
    expect(needsFreshStart("network")).toBe(false);
    expect(needsFreshStart("timeout")).toBe(false);
  });
});

// ---- deadlines and the upload request --------------------------------------------
describe("deadlines", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects a stalled promise at the deadline and asks it to abort", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const p = withDeadline(new Promise(() => {}), 1000, onTimeout);
    const check = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("gives big files longer, but never forever", () => {
    expect(uploadDeadlineMs(1)).toBe(121_000);
    expect(uploadDeadlineMs(MAX_VIDEO_BYTES)).toBe(120_000 + 360_000);
    expect(uploadDeadlineMs(10 * MAX_VIDEO_BYTES)).toBe(15 * 60_000);
  });
});

class FakeXhr {
  static last: FakeXhr;
  headers: Record<string, string> = {};
  method = "";
  url = "";
  status = 0;
  responseText = "";
  sent: unknown = null;
  aborted = false;
  upload: { onprogress: ((ev: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() { FakeXhr.last = this; }
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send(body: unknown) { this.sent = body; }
  abort() { this.aborted = true; this.onabort?.(); }
}

describe("createXhrUploader", () => {
  const make = () => createXhrUploader("https://proj.example.invalid/", "anon-key", () => new FakeXhr() as unknown as XMLHttpRequest);
  const req = (over: Partial<UploadRequest> = {}): UploadRequest => ({
    path: "installer/en/v2/walkthrough.mp4",
    file: new Blob([MP4]),
    contentType: "video/mp4",
    accessToken: "token-A",
    signal: new AbortController().signal,
    onProgress: () => {},
    ...over,
  });

  it("POSTs to the private bucket with the caller's own token, no upsert and no caching", async () => {
    const onProgress = vi.fn();
    const p = make()(req({ onProgress }));
    const x = FakeXhr.last;
    expect(x.method).toBe("POST");
    expect(x.url).toBe("https://proj.example.invalid/storage/v1/object/app-training/installer/en/v2/walkthrough.mp4");
    expect(x.headers).toEqual({
      authorization: "Bearer token-A", apikey: "anon-key", "x-upsert": "false", "content-type": "video/mp4", "cache-control": "no-store",
    });
    x.upload.onprogress?.({ loaded: 5, total: 19, lengthComputable: true });
    expect(onProgress).toHaveBeenCalledWith(5, 19);
    x.status = 200;
    x.onload?.();
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("reports a duplicate as 409 (from the body when storage wraps it in a 400)", async () => {
    const p = make()(req());
    FakeXhr.last.status = 400;
    FakeXhr.last.responseText = JSON.stringify({ statusCode: "409", error: "Duplicate" });
    FakeXhr.last.onload?.();
    await expect(p).resolves.toEqual({ ok: false, status: 409 });
  });

  it("aborts when the caller cancels", async () => {
    const ctl = new AbortController();
    const p = make()(req({ signal: ctl.signal }));
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    expect(FakeXhr.last.aborted).toBe(true);
  });

  it("encodes each path segment", () => {
    expect(storageObjectUrl("https://x.invalid", "a b/c#d.mp4")).toBe("https://x.invalid/storage/v1/object/app-training/a%20b/c%23d.mp4");
  });
});

// ---- the run ---------------------------------------------------------------------
/** A small in-memory stand-in for the RPCs and storage, with the migration's
 * rules for the parts the client depends on. Objects keep their real bytes so
 * a read-back digest means something. */
function fakeServer() {
  const users: Record<string, string> = { "token-A": "user-A", "token-B": "user-B" };
  type Obj = { owner: string; size: number; mime: string; bytes: Uint8Array };
  const reservations = new Map<string, { id: string; req: string; slug: string; version: number; state: string; assets: { kind: string; path: string; bytes: number; mime: string }[] }>();
  const objects = new Map<string, Obj>();
  const uploads: { path: string; token: string }[] = [];
  const rpcCalls: { fn: string; token: string }[] = [];
  const digests: { path: string; token: string }[] = [];
  let session: { userId: string; accessToken: string } | null = { userId: "user-A", accessToken: "token-A" };
  let publishError: unknown = null;
  let publishTamper = false;
  let loseNextPublishReply = false;
  let activations = 0;
  let uploadImpl: ((r: UploadRequest) => Promise<{ ok: true } | { ok: false; status: number }>) | null = null;
  let nextVersion = 2;

  const deps: ImportDeps = {
    getSession: async () => session,
    rpc: async ({ fn, args, accessToken }) => {
      rpcCalls.push({ fn, token: accessToken });
      const caller = users[accessToken];
      if (fn === "app_training_import_reserve") {
        const e = args.p_entry as ReturnType<typeof reservePayload>;
        const key = `${caller}:${args.p_request_id}:${e.slug}`;
        let r = reservations.get(key);
        if (!r) {
          const v = nextVersion++;
          const assets = (["video", "captions", "poster"] as const)
            .filter((k) => e[k])
            .map((k) => ({
              kind: k,
              path: `${e.slug}/en/v${v}/${k === "video" ? "walkthrough.mp4" : k === "captions" ? "captions.vtt" : "poster.jpg"}`,
              bytes: (e[k] as { bytes: number }).bytes,
              mime: (e[k] as { mime: string }).mime,
            }));
          r = { id: `imp-${e.slug}-${v}`, req: String(args.p_request_id), slug: String(e.slug), version: v, state: "reserved", assets };
          reservations.set(key, r);
        }
        return { data: { ...r, language: "en", expiresAt: "2026-09-23T18:00:00Z" }, error: null };
      }
      if (fn === "app_training_import_status") {
        const ids = args.p_ids as string[];
        return {
          data: [...reservations.values()].filter((r) => ids.includes(r.id)).map((r) => ({
            id: r.id, slug: r.slug, version: r.version, state: r.state, expired: false,
            assets: r.assets.map((a) => {
              const o = objects.get(a.path);
              return { ...a, present: !!o, ownedByYou: o?.owner === caller, storedBytes: o?.size ?? null, storedMime: o?.mime ?? null };
            }),
          })),
          error: null,
        };
      }
      if (fn === "app_training_import_publish") {
        if (publishError) return { data: null, error: publishError };
        const ids = args.p_ids as string[];
        const rows = [...reservations.values()].filter((r) => ids.includes(r.id));
        const out = rows.map((r) => {
          const already = r.state === "published";
          if (!already) activations++;
          r.state = "published";
          return { id: r.id, slug: r.slug, language: "en", version: r.version, active: true, alreadyPublished: already };
        });
        if (loseNextPublishReply) {
          // Committed on the server; the answer never reached the browser.
          loseNextPublishReply = false;
          throw new TypeError("Failed to fetch");
        }
        return { data: publishTamper ? out.slice(1) : out, error: null };
      }
      if (fn === "app_training_import_cancel") {
        const r = [...reservations.values()].find((x) => x.id === args.p_id);
        if (!r) return { data: null, error: { code: "P0002", hint: "not_found" } };
        if (r.state === "reserved") r.state = "cancelled";
        return { data: { id: r.id, state: r.state }, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
    upload: async (r) => {
      uploads.push({ path: r.path, token: r.accessToken });
      if (uploadImpl) return uploadImpl(r);
      if (objects.has(r.path)) return { ok: false, status: 409 };
      r.onProgress(r.file.size, r.file.size);
      objects.set(r.path, { owner: users[r.accessToken], size: r.file.size, mime: r.contentType, bytes: new Uint8Array(await r.file.arrayBuffer()) });
      return { ok: true };
    },
    storedSha256: async ({ path, accessToken }) => {
      digests.push({ path, token: accessToken });
      const o = objects.get(path);
      if (!o) throw new ImportError("server");
      return sha256Hex(new Blob([o.bytes as BlobPart]));
    },
  };
  return {
    deps, objects, uploads, rpcCalls, digests, reservations,
    activations: () => activations,
    fns: () => rpcCalls.map((c) => c.fn),
    setSession: (s: typeof session) => { session = s; },
    failPublish: (e: unknown) => { publishError = e; },
    tamperPublish: () => { publishTamper = true; },
    losePublishReply: () => { loseNextPublishReply = true; },
    setUpload: (f: typeof uploadImpl) => { uploadImpl = f; },
    put: (path: string, owner: string, bytes: Uint8Array, mime: string) =>
      objects.set(path, { owner, size: bytes.length, mime, bytes }),
  };
}

function runOpts(over: Partial<Parameters<typeof runImport>[3]> = {}) {
  const sessions: ImportSession[] = [];
  const progress: ImportProgress[] = [];
  return {
    sessions,
    progress,
    opts: {
      actorId: "user-A",
      signal: new AbortController().signal,
      onProgress: (p: ImportProgress) => progress.push(p),
      onSession: (s: ImportSession) => sessions.push(s),
      ...over,
    },
  };
}

const fresh = (): ImportSession => ({ requestId: "req", reservations: [] });
const bytesOf = (s: string | Uint8Array) => (typeof s === "string" ? new TextEncoder().encode(s) : s);

describe("runImport", () => {
  it("reserves, uploads, verifies and only then reports what publish confirmed", async () => {
    const plan = await planFor("installer", "foreman", "leadership");
    const srv = fakeServer();
    const { opts, sessions, progress } = runOpts();
    const out = await runImport(plan, { requestId: "req-1", reservations: [] }, srv.deps, opts);
    expect(out.map((o) => [o.slug, o.version, o.active, o.alreadyPublished])).toEqual([
      ["installer", 2, true, false], ["foreman", 3, true, false], ["leadership", 4, true, false],
    ]);
    expect(srv.uploads).toHaveLength(9);
    expect([...srv.uploads, ...srv.rpcCalls].every((u) => u.token === "token-A")).toBe(true);
    expect(srv.digests).toEqual([]); // every file was stored by this run and answered 200
    expect(srv.fns().at(-1)).toBe("app_training_import_publish");
    expect(sessions[0].reservations.map((r) => r.id)).toEqual(["imp-installer-2", "imp-foreman-3", "imp-leadership-4"]);
    const last = progress.at(-1)!;
    expect(last.step).toBe("publishing");
    expect(Object.values(last.assets).every((a) => a.state === "stored")).toBe(true);
  });

  it("never lets B's token carry A's import, even when B signs in between the check and the send", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    // Snapshot says A; by the time the transport runs, B is signed in. A
    // shared client would now send B's token. The transport gets A's.
    const rpc = srv.deps.rpc;
    srv.deps.rpc = async (req) => {
      srv.setSession({ userId: "user-B", accessToken: "token-B" });
      return rpc(req);
    };
    await expect(runImport(plan, fresh(), srv.deps, runOpts().opts)).rejects.toMatchObject({ code: "accountChanged" });
    expect(srv.rpcCalls).toEqual([{ fn: "app_training_import_reserve", token: "token-A" }]);
    expect(srv.uploads).toEqual([]);
    expect(srv.fns()).not.toContain("app_training_import_publish");
  });

  it("stops the moment a different account is signed in, and never uploads on its token", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    let n = 0;
    srv.setUpload(async (r) => {
      n++;
      srv.put(r.path, "user-A", bytesOf(new Uint8Array(await r.file.arrayBuffer())), r.contentType);
      if (n === 1) srv.setSession({ userId: "user-B", accessToken: "token-B" });
      return { ok: true };
    });
    await expect(runImport(plan, fresh(), srv.deps, runOpts().opts)).rejects.toMatchObject({ code: "accountChanged" });
    expect(srv.uploads.map((u) => u.token)).toEqual(["token-A"]);
    expect(srv.rpcCalls.every((c) => c.token === "token-A")).toBe(true);
    expect(srv.fns()).not.toContain("app_training_import_publish");
  });

  it("does not hand reservations to the screen once the account has changed", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    const rpc = srv.deps.rpc;
    srv.deps.rpc = async (req) => {
      const res = await rpc(req);
      if (req.fn === "app_training_import_reserve") srv.setSession({ userId: "user-B", accessToken: "token-B" });
      return res;
    };
    const { opts, sessions } = runOpts();
    await expect(runImport(plan, fresh(), srv.deps, opts)).rejects.toMatchObject({ code: "accountChanged" });
    expect(sessions).toEqual([]);
    expect(srv.uploads).toEqual([]);
  });

  it("stops when signed out, and when reading the session itself hangs", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    srv.setSession(null);
    await expect(runImport(plan, fresh(), srv.deps, runOpts().opts)).rejects.toMatchObject({ code: "signedOut" });
    const hung = fakeServer();
    hung.deps.getSession = () => new Promise(() => {});
    hung.deps.sessionDeadlineMs = 20;
    await expect(runImport(plan, fresh(), hung.deps, runOpts().opts)).rejects.toMatchObject({ code: "timeout" });
    expect(srv.rpcCalls).toEqual([]);
    expect(hung.rpcCalls).toEqual([]);
  });

  it("accepts a file already at its path only after reading it back and matching the fingerprint", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    // Our earlier upload landed but its answer was lost.
    srv.put("installer/en/v2/walkthrough.mp4", "user-A", MP4, "video/mp4");
    const out = await runImport(plan, fresh(), srv.deps, runOpts().opts);
    expect(out[0].active).toBe(true);
    expect(srv.uploads.map((u) => u.path)).not.toContain("installer/en/v2/walkthrough.mp4");
    expect(srv.digests).toEqual([{ path: "installer/en/v2/walkthrough.mp4", token: "token-A" }]);
  });

  it("refuses a same-owner, same-size, same-type file whose bytes differ", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    const impostor = MP4.slice();
    impostor[MP4.length - 1] ^= 0xff;
    srv.put("installer/en/v2/walkthrough.mp4", "user-A", impostor, "video/mp4");
    await expect(runImport(plan, fresh(), srv.deps, runOpts().opts)).rejects.toMatchObject({ code: "mismatch" });
    expect(srv.fns()).not.toContain("app_training_import_publish");
  });

  it("digests a 409 before accepting it: identical bytes recover, different bytes of the same size do not", async () => {
    const plan = await planFor("installer");
    for (const [same, expected] of [[true, "ok"], [false, "mismatch"]] as const) {
      const srv = fakeServer();
      srv.setUpload(async (r) => {
        const real = new Uint8Array(await r.file.arrayBuffer());
        const stored = same ? real : real.map((b) => b ^ 0x01);
        srv.put(r.path, "user-A", stored, r.contentType);
        return { ok: false, status: 409 };
      });
      const run = runImport(plan, fresh(), srv.deps, runOpts().opts);
      if (expected === "ok") {
        await expect(run).resolves.toHaveLength(1);
        expect(srv.digests).toHaveLength(3);
      } else {
        await expect(run).rejects.toMatchObject({ code: "mismatch" });
        expect(srv.fns()).not.toContain("app_training_import_publish");
      }
    }
  });

  it.each([
    ["someone else's object", { owner: "user-B" }],
    ["a different byte count", { size: 1 }],
    ["a different type", { mime: "video/quicktime" }],
  ])("refuses to publish over %s at a reserved path", async (_why, over) => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    srv.put("installer/en/v2/captions.vtt", "user-A", bytesOf(VTT), "text/vtt");
    Object.assign(srv.objects.get("installer/en/v2/captions.vtt")!, over);
    await expect(runImport(plan, fresh(), srv.deps, runOpts().opts)).rejects.toMatchObject({ code: "mismatch" });
    expect(srv.fns()).not.toContain("app_training_import_publish");
  });

  it("gives up a stalled upload at its deadline, then resumes the same reservation", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    let stalled: AbortSignal | null = null;
    srv.setUpload((r) => {
      stalled = r.signal;
      return new Promise(() => {});
    });
    srv.deps.uploadDeadline = () => 20;
    const first = runOpts();
    await expect(runImport(plan, fresh(), srv.deps, first.opts)).rejects.toMatchObject({ code: "timeout" });
    expect(stalled!.aborted).toBe(true);
    expect(srv.fns()).not.toContain("app_training_import_publish");
    expect(Object.values(first.progress.at(-1)!.assets).some((a) => a.state === "failed")).toBe(true);

    srv.setUpload(null);
    const out = await runImport(plan, first.sessions[0], srv.deps, runOpts().opts);
    expect(out[0].version).toBe(2);
    expect(srv.reservations.size).toBe(1);
  });

  it("gives up an RPC that never answers, and aborts it", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    let sig: AbortSignal | null = null;
    srv.deps.rpc = (req) => {
      sig = req.signal;
      return new Promise(() => {});
    };
    srv.deps.rpcDeadlineMs = 20;
    await expect(runImport(plan, fresh(), srv.deps, runOpts().opts)).rejects.toMatchObject({ code: "timeout" });
    expect(sig!.aborted).toBe(true);
  });

  it("a publish that committed but lost its answer is found on retry, not published twice", async () => {
    const plan = await planFor("installer", "foreman");
    const srv = fakeServer();
    srv.losePublishReply();
    const first = runOpts();
    await expect(runImport(plan, fresh(), srv.deps, first.opts)).rejects.toMatchObject({ code: "network" });
    expect(srv.activations()).toBe(2);
    const uploads = srv.uploads.length;
    const again = await runImport(plan, first.sessions[0], srv.deps, runOpts().opts);
    expect(again.map((o) => [o.slug, o.alreadyPublished])).toEqual([["installer", true], ["foreman", true]]);
    expect(srv.activations()).toBe(2);
    expect(srv.uploads.length).toBe(uploads);
    expect(srv.reservations.size).toBe(2);
  });

  it("cancels on request without claiming anything", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    const ctl = new AbortController();
    const progress: ImportProgress[] = [];
    srv.setUpload((r) => new Promise((_, reject) => {
      r.signal.addEventListener("abort", () => reject(new ImportError("cancelled")));
      ctl.abort();
    }));
    await expect(runImport(plan, fresh(), srv.deps, runOpts({ signal: ctl.signal, onProgress: (p) => progress.push(p) }).opts))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(srv.fns()).not.toContain("app_training_import_publish");
    const after = progress.length;
    await Promise.resolve();
    expect(progress.length).toBe(after);
  });

  it("surfaces a refused publish as an error, never as success", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    srv.failPublish({ code: "22023", hint: "newer_published", message: "newer" });
    await expect(runImport(plan, fresh(), srv.deps, runOpts().opts)).rejects.toMatchObject({ code: "newerPublished" });
  });

  it("does not accept a publish answer that leaves a walkthrough out", async () => {
    const plan = await planFor("installer", "foreman");
    const srv = fakeServer();
    srv.tamperPublish();
    await expect(runImport(plan, fresh(), srv.deps, runOpts().opts)).rejects.toMatchObject({ code: "badResponse" });
  });

  it("reports an already-published retry as already published", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    const first = runOpts();
    await runImport(plan, fresh(), srv.deps, first.opts);
    const uploads = srv.uploads.length;
    const again = await runImport(plan, first.sessions[0], srv.deps, runOpts().opts);
    expect(again[0].alreadyPublished).toBe(true);
    expect(srv.uploads.length).toBe(uploads);
  });

  it("refuses a failed upload with the storage status, not a success", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    srv.setUpload(async () => ({ ok: false, status: 403 }));
    await expect(runImport(plan, fresh(), srv.deps, runOpts().opts)).rejects.toMatchObject({ code: "notAllowed" });
  });
});

describe("cancelReservations", () => {
  it("reports which reservations were already published instead of claiming nothing was", async () => {
    const plan = await planFor("installer", "foreman");
    const srv = fakeServer();
    srv.losePublishReply();
    const first = runOpts();
    await expect(runImport(plan, fresh(), srv.deps, first.opts)).rejects.toMatchObject({ code: "network" });
    const out = await cancelReservations(first.sessions[0], "user-A", srv.deps);
    expect(out).toEqual({ cancelled: [], published: [{ slug: "installer", version: 2 }, { slug: "foreman", version: 3 }] });
  });

  it("cancels unpublished ones on the actor's own token, and stops for another account", async () => {
    const plan = await planFor("installer");
    const srv = fakeServer();
    srv.setUpload(() => new Promise(() => {}));
    srv.deps.uploadDeadline = () => 10;
    const first = runOpts();
    await expect(runImport(plan, fresh(), srv.deps, first.opts)).rejects.toMatchObject({ code: "timeout" });
    srv.setSession({ userId: "user-B", accessToken: "token-B" });
    await expect(cancelReservations(first.sessions[0], "user-A", srv.deps)).rejects.toMatchObject({ code: "accountChanged" });
    srv.setSession({ userId: "user-A", accessToken: "token-A" });
    expect(await cancelReservations(first.sessions[0], "user-A", srv.deps)).toEqual({ cancelled: ["installer"], published: [] });
    expect(srv.rpcCalls.every((c) => c.token === "token-A")).toBe(true);
  });
});

// ---- the two token-bound transports -----------------------------------------------
describe("createFetchRpc", () => {
  it("sends exactly the captured token, not the shared client's", async () => {
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const rpc = createFetchRpc("https://proj.example.invalid/", "anon-key", fetchImpl as unknown as typeof fetch);
    const signal = new AbortController().signal;
    await expect(rpc({ fn: "app_training_import_status", args: { p_ids: ["x"] }, accessToken: "token-A", signal }))
      .resolves.toEqual({ data: { ok: 1 }, error: null });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://proj.example.invalid/rest/v1/rpc/app_training_import_status");
    expect(init).toMatchObject({
      method: "POST", cache: "no-store", credentials: "omit", signal,
      headers: { apikey: "anon-key", authorization: "Bearer token-A" },
      body: JSON.stringify({ p_ids: ["x"] }),
    });
  });

  it("returns PostgREST's error body so the hint survives", async () => {
    const body = { code: "22023", hint: "expired", message: "expired" };
    const rpc = createFetchRpc("https://x.invalid", "k", (async () => new Response(JSON.stringify(body), { status: 400 })) as typeof fetch);
    const res = await rpc({ fn: "app_training_import_publish", args: {}, accessToken: "t", signal: new AbortController().signal });
    expect(res).toEqual({ data: null, error: body });
    expect(importErrorFromServer(res.error).code).toBe("expired");
  });

  it("refuses a function name that is not a plain identifier", async () => {
    const rpc = createFetchRpc("https://x.invalid", "k", vi.fn() as unknown as typeof fetch);
    await expect(rpc({ fn: "../admin", args: {}, accessToken: "t", signal: new AbortController().signal })).rejects.toBeInstanceOf(ImportError);
  });
});

describe("createStoredDigest", () => {
  const req = (maxBytes: number) => ({ path: "installer/en/v2/walkthrough.mp4", accessToken: "token-A", signal: new AbortController().signal, maxBytes });

  it("reads the caller's own staged object with its token and hashes the bytes", async () => {
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(MP4, { status: 200 }));
    const digest = await createStoredDigest("https://x.invalid", "k", fetchImpl as unknown as typeof fetch)(req(MP4.length));
    expect(digest).toBe(await sha256Hex(new Blob([MP4])));
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://x.invalid/storage/v1/object/authenticated/app-training/installer/en/v2/walkthrough.mp4");
    expect(init).toMatchObject({ method: "GET", cache: "no-store", credentials: "omit", headers: { authorization: "Bearer token-A" } });
  });

  it("stops reading past the expected size", async () => {
    const fetchImpl = (async () => new Response(new Uint8Array(100), { status: 200 })) as typeof fetch;
    await expect(createStoredDigest("https://x.invalid", "k", fetchImpl)(req(10))).rejects.toMatchObject({ code: "mismatch" });
  });

  it("treats a refused read as a failure, never as a match", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 400 })) as typeof fetch;
    await expect(createStoredDigest("https://x.invalid", "k", fetchImpl)(req(10))).rejects.toMatchObject({ code: "server" });
  });
});
