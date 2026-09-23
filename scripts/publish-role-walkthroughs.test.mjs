#!/usr/bin/env node
// The walkthrough publisher's refusals, against real files in a temp folder.
// Offline: no database, no key, no network. Run:
//   node scripts/publish-role-walkthroughs.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lastCueEnd, parseTranscriptJson, privateDataHits, validateManifest } from "./lib/role-walkthroughs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "walkthroughs-"));
const outside = mkdtempSync(join(tmpdir(), "walkthroughs-outside-"));

// The package's own transcript shape (assemble.py): caption-sized chunks,
// contiguous inside a scene, with a pause between scenes.
function transcriptJson(first, extra = {}) {
  return JSON.stringify({
    language: "en",
    voice: "OpenAI Cedar (AI-generated)",
    contentStatus: "proposal",
    title: "Walkthrough",
    segments: [
      { startSeconds: 0.4, endSeconds: 2.1, text: first },
      { startSeconds: 2.1, endSeconds: 3.9, text: "continues in the same scene." },
      { startSeconds: 12.4, endSeconds: 14.0, text: "A second scene starts here." },
    ],
    ...extra,
  });
}
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(32)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const vtt = "WEBVTT\n\n00:00.000 --> 00:04.000\nClock in from Today.\n\n04:55.000 --> 04:59.500\nThat is the whole proposed flow.\n";
for (const slug of ["installer", "foreman", "leadership"]) {
  writeFileSync(join(dir, `${slug}.mp4`), mp4);
  writeFileSync(join(dir, `${slug}.vtt`), vtt);
  writeFileSync(join(dir, `${slug}.json`), transcriptJson(`The ${slug} walkthrough narration`));
}
writeFileSync(join(dir, "poster.png"), png);
writeFileSync(join(dir, "fake.mp4"), Buffer.from("not really a video at all"));
writeFileSync(join(dir, "leaky.json"), transcriptJson("Call Dana on 801-555-0142 or dana@example.com about the Smith job."));
writeFileSync(join(dir, "plain.txt"), "Plain text transcripts are not the package contract.");
writeFileSync(join(outside, "secret.mp4"), mp4);
symlinkSync(join(outside, "secret.mp4"), join(dir, "linked.mp4"));
mkdirSync(join(dir, "sub"));
writeFileSync(join(dir, "sub", "nested.mp4"), mp4);

const entry = (slug, extra = {}) => ({
  slug,
  title: `${slug} walkthrough`,
  minRole: { installer: "installer", foreman: "foreman", leadership: "supervisor" }[slug],
  language: "en",
  contentStatus: "proposal",
  durationSeconds: 300,
  videoFile: `${slug}.mp4`,
  captionsFile: `${slug}.vtt`,
  transcriptFile: `${slug}.json`,
  chapters: [
    { seconds: 0, title: "Clock in", status: "live" },
    { seconds: 60, title: "Job card", status: "proposal" },
    { seconds: 200, title: "Approvals", status: "mixed" },
  ],
  ...extra,
});
const check = (m, opts = {}) => validateManifest(m, { baseDir: dir, ...opts });
const refused = (m, pattern, opts) => {
  const { errors } = check(Array.isArray(m) ? { videos: m } : m, opts);
  assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern} in:\n${errors.join("\n")}`);
};

// ---- a good manifest ------------------------------------------------------
{
  const { errors, plan } = check({ videos: [entry("installer", { posterFile: "poster.png" }), entry("foreman"), entry("leadership")] }, { version: 2 });
  assert.deepEqual(errors, []);
  assert.equal(plan.length, 3);
  const leadership = plan.find((p) => p.slug === "leadership");
  assert.equal(leadership.row.min_role, "supervisor");
  assert.equal(leadership.row.video_path, "leadership/en/v2/walkthrough.mp4");
  assert.equal(leadership.row.captions_path, "leadership/en/v2/captions.vtt");
  assert.equal(leadership.row.poster_path, null);
  assert.equal(leadership.row.content_status, "proposal");
  // Every segment's words, in order: one scene's chunks run on, a pause
  // between scenes starts a paragraph.
  assert.equal(
    leadership.row.transcript_text,
    "The leadership walkthrough narration continues in the same scene.\n\nA second scene starts here.",
  );
  const installer = plan.find((p) => p.slug === "installer");
  assert.deepEqual(installer.uploads.map((u) => u.object), [
    "installer/en/v2/walkthrough.mp4",
    "installer/en/v2/captions.vtt",
    "installer/en/v2/poster.png",
  ]);
  assert.deepEqual(installer.uploads.map((u) => u.contentType), ["video/mp4", "text/vtt", "image/png"]);
  // An entry's own version beats the flag.
  assert.equal(check({ videos: [entry("foreman", { version: 7 })] }).plan[0].row.video_path, "foreman/en/v7/walkthrough.mp4");
  // A nested file inside the folder is fine.
  assert.deepEqual(check({ videos: [entry("installer", { videoFile: "sub/nested.mp4" })] }).errors, []);
}

// ---- exact roles, status and slugs ---------------------------------------
refused([entry("leadership", { minRole: "foreman" })], /minRole for leadership must be exactly 'supervisor'/);
refused([entry("installer", { minRole: "owner" })], /minRole for installer must be exactly 'installer'/);
refused([entry("crew")], /slug must be installer, foreman or leadership/);
refused([entry("installer"), entry("installer")], /slug listed twice/);
refused([entry("installer", { contentStatus: "live" })], /contentStatus must be 'proposal'/);
refused([entry("installer", { language: "fr" })], /language must be/);
refused([entry("installer", { version: 0 })], /version must be/);
refused([entry("installer", { title: "" })], /title must be/);
refused([], /no walkthroughs/);
refused({ nope: true }, /object with a `videos` list/);
// A bare list is not the package's manifest shape.
assert.match(check([entry("installer")]).errors.join("\n"), /object with a `videos` list/);

// ---- paths and file types -------------------------------------------------
refused([entry("installer", { videoFile: "../outside.mp4" })], /inside the manifest's folder/);
refused([entry("installer", { videoFile: join(outside, "secret.mp4") })], /inside the manifest's folder/);
refused([entry("installer", { videoFile: "linked.mp4" })], /regular file, not a link/);
refused([entry("installer", { videoFile: "installer.mov" })], /must be \.mp4/);
refused([entry("installer", { captionsFile: "installer.json" })], /must be \.vtt/);
refused([entry("installer", { transcriptFile: "plain.txt" })], /transcriptFile: must be \.json/);
refused([entry("installer", { videoFile: "fake.mp4" })], /not a real \.mp4/);
refused([entry("installer", { videoFile: "missing.mp4" })], /not found/);
refused([entry("installer", { posterFile: "installer.mp4" })], /posterFile: must be/);
refused([entry("installer")], /over the 10-byte limit/, { limits: { ...(await import("./lib/role-walkthroughs.mjs")).LIMITS, videoBytes: 10 } });

// ---- chapters and captions stay inside the video --------------------------
refused([entry("installer", { chapters: [{ seconds: 5, title: "a", status: "live" }] })], /first chapter starts at 0/);
refused([entry("installer", { chapters: [{ seconds: 0, title: "a", status: "live" }, { seconds: 300, title: "b", status: "live" }] })], /past the end/);
refused([entry("installer", { chapters: [{ seconds: 0, title: "a", status: "live" }, { seconds: 0, title: "b", status: "live" }] })], /in order/);
refused([entry("installer", { chapters: [{ seconds: 0, title: "a", status: "shipped" }] })], /status must be proposal, live or mixed/);
refused([entry("installer", { chapters: [{ seconds: 0, title: " ", status: "live" }] })], /title must be 1–120/);
refused([entry("installer", { chapters: [] })], /non-empty/);
refused([entry("installer", { durationSeconds: 120 })], /captions run to 299\.5s, past the end/);
assert.equal(lastCueEnd(vtt), 299.5);
assert.equal(lastCueEnd("WEBVTT\n\n01:00:00.000 --> 01:00:02.250\nx"), 3602.25);

// ---- no private contact details -------------------------------------------
refused([entry("installer", { transcriptFile: "leaky.json" })], /transcript contains a phone number/);
refused([entry("installer", { transcriptFile: "leaky.json" })], /transcript contains an email address/);

// ---- the transcript JSON contract, exactly ---------------------------------
{
  const opts = { language: "en", durationSeconds: 300 };
  const seg = (a, b, text) => ({ startSeconds: a, endSeconds: b, text });
  const doc = (segments, extra = {}) => JSON.stringify({ language: "en", segments, ...extra });
  const errs = (raw, o = opts) => parseTranscriptJson(raw, o).errors.join("\n");
  assert.deepEqual(parseTranscriptJson(doc([seg(0, 1, "One"), seg(1, 2, "two")]), opts), { errors: [], text: "One two" });
  assert.match(errs("not json"), /not valid JSON/);
  assert.match(errs(doc([])), /non-empty segments/);
  assert.match(errs(doc([seg(0, 1, "a")], { language: "es" })), /does not match/);
  assert.match(errs(doc([seg(0, 1, "a")], { contentStatus: "live" })), /contentStatus must be 'proposal'/);
  assert.match(errs(doc([seg(0, 1, "a")], { speakers: [] })), /unexpected field 'speakers'/);
  assert.match(errs(doc([{ ...seg(0, 1, "a"), start: 0 }])), /unexpected field 'start'/);
  assert.match(errs(doc([seg(2, 1, "a")])), /endSeconds must be after/);
  assert.match(errs(doc([seg(-1, 1, "a")])), /startSeconds must be/);
  assert.match(errs(doc([seg(5, 6, "a"), seg(1, 2, "b")])), /time order/);
  assert.match(errs(doc([seg(0, 1, "a"), seg(1, 1000, "b")])), /past the end/);
  assert.match(errs(doc([seg(0, 1, "  ")])), /text must not be empty/);
  refused([entry("installer", { durationSeconds: 10, chapters: [{ seconds: 0, title: "a", status: "live" }] })], /transcript segment 3: ends at 14s/);
}
refused([entry("installer", { chapters: [{ seconds: 0, title: "Call 801.555.0142", status: "live" }] })], /chapter title contains a phone number/);
assert.deepEqual(privateDataHits("Clock in at 7:30, then 12 units by 3 pm."), []);

// ---- the CLI: dry run by default, and no credential ever needed or shown ---
writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, videos: [entry("installer"), entry("foreman"), entry("leadership")] }));
const cli = (args, env = {}) =>
  spawnSync(process.execPath, [join(here, "publish-role-walkthroughs.mjs"), ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
{
  const r = cli(["--manifest", join(dir, "manifest.json")], { SUPABASE_SERVICE_ROLE_KEY: "sb_secret_DO_NOT_PRINT" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Validation only — nothing was read from or written to Supabase/);
  assert.match(r.stdout, /leadership {2}\(floor: supervisor, v1/);
  assert.match(r.stdout, /transcript {2}: \d+ characters, 2 paragraph\(s\)/);
  assert.doesNotMatch(r.stdout + r.stderr, /DO_NOT_PRINT/);
}
{
  // The old service-key publisher is retired, even with a credential present.
  const r = cli(["--manifest", join(dir, "manifest.json"), "--apply"], {
    SUPABASE_URL: "https://czprjcskmzzagdztqonm.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_DO_NOT_PRINT",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--apply is retired/);
  assert.match(r.stderr, /in-app|importer/);
  assert.doesNotMatch(r.stdout + r.stderr, /DO_NOT_PRINT/);
}
{
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ videos: [entry("leadership", { minRole: "installer" })] }));
  const r = cli(["--manifest", join(dir, "bad.json")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Package refused/);
}
// No path in the script can reach the network: it imports no Supabase client.
assert.doesNotMatch(readFileSync(join(here, "publish-role-walkthroughs.mjs"), "utf8"), /supabase-admin|createClient|supabase-key/);

rmSync(dir, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });
console.log("publish-role-walkthroughs: roles, status, paths, file types, sizes, chapter/caption bounds, private-data guard, transcript JSON contract and validation-only CLI passed");
