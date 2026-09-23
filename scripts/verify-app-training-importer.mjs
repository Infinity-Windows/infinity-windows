// The walkthrough IMPORTER migration, replayed on top of the catalog migration
// in a disposable PostgreSQL under every kind of caller. No live records, no
// network. Synthetic titles and fingerprints only.
//
//   PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js \
//     node scripts/verify-app-training-importer.mjs
//
// What it proves (docs/role-training-importer.md, "What the server checks"):
//   - only supervisor/owner (and aliases) from the REAL profile row may reserve,
//     see status, cancel or publish; anonymous, installer, foreman, partner,
//     switched-off, Removed, unknown-role and profile-less callers cannot, and
//     an owner who is "off today" still can
//   - malformed reservations are refused, missing and null fields included
//   - versions are allocated past every catalog row and reservation, a
//     retried request gets its own reservation back, and a changed one is
//     refused
//   - a browser may upload ONLY to a path it reserved, unexpired, unpublished;
//     never another person's path, a published path or an unreserved one; no
//     overwrite, update or delete — with and without an older permissive
//     storage policy in place, and other buckets untouched
//   - publication checks storage's own owner, byte count and type for every
//     file; a missing or mismatched file, an expired or cancelled reservation,
//     a revoked caller or a newer live version refuses it and leaves the old
//     walkthrough playing; a batch is all or nothing
//   - publishing twice returns the same record and publishes nothing new
//   - staging and catalog tables stay closed to direct writes
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const { PGlite } = await import(process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
const db = new PGlite();

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PEOPLE = {
  installer: { n: 1, role: "installer" },
  foreman: { n: 2, role: "foreman" },
  supervisor: { n: 3, role: "supervisor" },
  owner: { n: 4, role: "owner" },
  lead: { n: 5, role: "lead" },
  admin: { n: 6, role: "admin" },
  bigBoss: { n: 7, role: "big_boss" },
  offTodayOwner: { n: 8, role: "owner", active: false },
  partner: { n: 9, role: "owner", is_partner: true },
  revokedOwner: { n: 10, role: "owner", access_revoked_at: "now()" },
  retiredOwner: { n: 11, role: "owner", retired_at: "now()" },
  unknownRole: { n: 12, role: "contractor" },
  supervisor2: { n: 13, role: "supervisor" },
  laterRevoked: { n: 14, role: "supervisor" },
};

await db.exec(`
create role authenticated; create role anon; create role service_role bypassrls;
create schema auth; create schema storage;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public, auth, storage to authenticated, anon, service_role;
create table profiles(id uuid primary key, role text, active boolean default true, is_partner boolean default false, retired_at timestamptz, access_revoked_at timestamptz);
create function role_rank(p_role text) returns int language sql immutable as $$
  select case p_role when 'owner' then 3 when 'big_boss' then 3 when 'supervisor' then 2 when 'admin' then 2 when 'foreman' then 1 when 'lead' then 1 else 0 end $$;
create function is_partner_user() returns boolean language sql stable security definer as $$select coalesce((select is_partner from profiles where id=auth.uid()),false)$$;
grant execute on function is_partner_user() to authenticated;
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
-- The columns storage itself fills in: owner/owner_id from the caller's token,
-- metadata.size and metadata.mimetype from the bytes it actually received.
create table storage.objects(
  id uuid primary key default gen_random_uuid(), bucket_id text, name text,
  owner uuid, owner_id text, metadata jsonb, created_at timestamptz default now(),
  unique (bucket_id, name));
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated, anon, service_role;
-- An accidental PUBLIC bucket of the same name, already there: the importer
-- must pin it private.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
  values ('app-training', 'app-training', true, null, null);
`);
for (const [, p] of Object.entries(PEOPLE)) {
  await db.query(
    `insert into profiles(id, role, active, is_partner, retired_at, access_revoked_at)
     values ($1, $2, $3, $4, ${p.retired_at ?? "null"}, ${p.access_revoked_at ?? "null"})`,
    [uid(p.n), p.role, p.active ?? true, p.is_partner ?? false],
  );
}

const base = await readFile(new URL("../supabase/migrations/20261025000000_app_training_videos.sql", import.meta.url), "utf8");
const importer = await readFile(new URL("../supabase/migrations/20261025010000_app_training_importer.sql", import.meta.url), "utf8");
await db.exec(base);
await db.exec(importer);
// Replaying the importer is harmless (a retried `db push`).
await db.exec(importer);

async function asService() {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub','',false)");
  await db.exec("set role service_role");
}
async function asRoot() {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub','',false)");
}
async function as(person) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [person ? uid(PEOPLE[person].n) : ""]);
  await db.exec(person === null ? "set role anon" : "set role authenticated");
}
async function asStranger() {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid(99)]);
  await db.exec("set role authenticated");
}

await asRoot();
const bucket = (await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id='app-training'")).rows[0];
assert.equal(bucket.public, false, "an existing public bucket of that name is pinned private");
assert.equal(Number(bucket.file_size_limit), 47185920, "the bucket ceiling is the importer's 45 MiB, not 200 MB");
assert.deepEqual(bucket.allowed_mime_types, ["video/mp4", "text/vtt", "image/jpeg", "image/png", "image/webp"]);

// ---- helpers ---------------------------------------------------------------
const SHA = (c) => c.repeat(64);
const FLOOR = { installer: "installer", foreman: "foreman", leadership: "supervisor" };
function entry(slug, extra = {}) {
  return {
    slug, minRole: FLOOR[slug], language: "en", contentStatus: "proposal",
    title: `Synthetic ${slug} tour`, durationSeconds: 300,
    chapters: [{ seconds: 0, title: "Start", status: "live" }, { seconds: 120, title: "Idea", status: "proposal" }],
    transcriptText: "Synthetic narration.\n\nSecond paragraph.", version: null,
    video: { bytes: 1000, sha256: SHA("a"), mime: "video/mp4" },
    captions: { bytes: 100, sha256: SHA("b"), mime: "text/vtt" },
    poster: { bytes: 50, sha256: SHA("c"), mime: "image/jpeg" },
    ...extra,
  };
}
let reqN = 0;
const newReq = () => `10000000-0000-4000-8000-${String(++reqN).padStart(12, "0")}`;
async function reserve(e, req = newReq()) {
  return (await db.query("select public.app_training_import_reserve($1, $2::jsonb) r", [req, JSON.stringify(e)])).rows[0].r;
}
async function publish(ids) {
  return (await db.query("select public.app_training_import_publish($1::uuid[]) r", [ids])).rows[0].r;
}
async function status(ids) {
  return (await db.query("select public.app_training_import_status($1::uuid[]) r", [ids])).rows[0].r;
}
// The storage server's own insert, run as the caller (RLS applies), with the
// metadata it computes from the bytes it received. RETURNING, as storage does.
async function upload(person, path, bytes, mime, bucketId = "app-training") {
  await as(person);
  return db.query(
    `insert into storage.objects(bucket_id, name, owner, owner_id, metadata)
     values ($1, $2, $3::uuid, $3, jsonb_build_object('size', $4::bigint, 'mimetype', $5::text)) returning id, name`,
    [bucketId, path, uid(PEOPLE[person].n), bytes, mime],
  );
}
async function uploadAll(person, r, skip = []) {
  for (const a of r.assets) if (!skip.includes(a.kind)) await upload(person, a.path, a.bytes, a.mime);
}
async function rejectsWith(fn, code, why) {
  await assert.rejects(fn, (err) => {
    if (code && err.code !== code) {
      assert.fail(`${why}: expected SQLSTATE ${code}, got ${err.code} (${err.message})`);
    }
    return true;
  }, why);
}
async function activeVersions() {
  await asRoot();
  return Object.fromEntries(
    (await db.query("select slug, version from app_training_videos where active order by slug")).rows.map((r) => [r.slug, r.version]),
  );
}
async function catalogCount() {
  await asRoot();
  return (await db.query("select count(*)::int n from app_training_videos")).rows[0].n;
}

// ---- seed: v1 of each, published the service-key way ----------------------
await asService();
for (const slug of ["installer", "foreman", "leadership"]) {
  const p = `${slug}/en/v1`;
  await db.query(
    `insert into app_training_videos(slug,min_role,version,title,language,content_status,duration_seconds,video_path,captions_path,transcript_text,chapters,published_at,active)
     values ($1,$2,1,'Seeded tour','en','proposal',300,$3,$4,'Seeded narration.','[{"seconds":0,"title":"Start","status":"live"}]',now(),true)`,
    [slug, FLOOR[slug], `${p}/walkthrough.mp4`, `${p}/captions.vtt`],
  );
  await db.query("insert into storage.objects(bucket_id,name,metadata) values('app-training',$1,'{}'),('app-training',$2,'{}')",
    [`${p}/walkthrough.mp4`, `${p}/captions.vtt`]);
}

// ---- who may reserve ------------------------------------------------------
for (const person of ["installer", "foreman", "lead", "partner", "revokedOwner", "retiredOwner", "unknownRole"]) {
  await as(person);
  await rejectsWith(() => reserve(entry("installer")), "42501", `${person} cannot reserve`);
  await rejectsWith(() => status([uid(1)]), "42501", `${person} cannot read status`);
  await rejectsWith(() => publish([uid(1)]), "42501", `${person} cannot publish`);
  await rejectsWith(() => db.query("select public.app_training_import_cancel($1)", [uid(1)]), "42501", `${person} cannot cancel`);
}
await asStranger();
await rejectsWith(() => reserve(entry("installer")), "42501", "a login with no profile cannot reserve");
await as(null);
await rejectsWith(() => reserve(entry("installer")), "42501", "anonymous has no execute grant at all");
await rejectsWith(() => publish([uid(1)]), "42501", "anonymous cannot publish");
// The internals are not callable by anybody signed in.
await as("owner");
await rejectsWith(() => db.query("select public.app_training_importer_ok()"), "42501", "the role check is internal");
await rejectsWith(() => db.query("select public.app_training_import_lock('installer','en')"), "42501", "the lock is internal");

// ---- malformed reservations ------------------------------------------------
const withoutKey = (k) => { const e = entry("installer"); delete e[k]; return e; };
const malformed = [
  ["missing slug", withoutKey("slug")],
  ["null title", entry("installer", { title: null })],
  ["missing title", withoutKey("title")],
  ["blank title", entry("installer", { title: "   " })],
  ["unknown slug", entry("installer", { slug: "helper" })],
  ["floor mismatch", entry("installer", { minRole: "supervisor" })],
  ["leadership for foremen", entry("leadership", { minRole: "foreman" })],
  ["claims live", entry("installer", { contentStatus: "live" })],
  ["missing status", withoutKey("contentStatus")],
  ["language xx", entry("installer", { language: "xx" })],
  ["missing duration", withoutKey("durationSeconds")],
  ["zero duration", entry("installer", { durationSeconds: 0 })],
  ["long duration", entry("installer", { durationSeconds: 7201 })],
  ["fractional duration", entry("installer", { durationSeconds: 12.5 })],
  ["string duration", entry("installer", { durationSeconds: "300" })],
  ["huge duration", entry("installer", { durationSeconds: 1e300 })],
  ["missing chapters", withoutKey("chapters")],
  ["chapter without seconds", entry("installer", { chapters: [{ title: "Missing time", status: "proposal" }] })],
  ["chapter without title", entry("installer", { chapters: [{ seconds: 0, status: "live" }] })],
  ["chapter without status", entry("installer", { chapters: [{ seconds: 0, title: "a" }] })],
  ["chapter status only", entry("installer", { chapters: [{ status: "live" }] })],
  ["null chapter", entry("installer", { chapters: [null] })],
  ["chapter extra key", entry("installer", { chapters: [{ seconds: 0, title: "a", status: "live", href: "x" }] })],
  ["chapter past end", entry("installer", { chapters: [{ seconds: 0, title: "a", status: "live" }, { seconds: 300, title: "b", status: "live" }] })],
  ["missing transcript", withoutKey("transcriptText")],
  ["empty transcript", entry("installer", { transcriptText: " " })],
  ["missing video", withoutKey("video")],
  ["null captions", entry("installer", { captions: null })],
  ["video too large", entry("installer", { video: { bytes: 47185921, sha256: SHA("a"), mime: "video/mp4" } })],
  ["video empty", entry("installer", { video: { bytes: 0, sha256: SHA("a"), mime: "video/mp4" } })],
  ["video missing bytes", entry("installer", { video: { sha256: SHA("a"), mime: "video/mp4" } })],
  ["video wrong type", entry("installer", { video: { bytes: 10, sha256: SHA("a"), mime: "video/quicktime" } })],
  ["bad fingerprint", entry("installer", { video: { bytes: 10, sha256: "abc", mime: "video/mp4" } })],
  ["extra asset key", entry("installer", { video: { bytes: 10, sha256: SHA("a"), mime: "video/mp4", path: "leadership/en/v1/walkthrough.mp4" } })],
  ["poster gif", entry("installer", { poster: { bytes: 10, sha256: SHA("c"), mime: "image/gif" } })],
  ["poster too large", entry("installer", { poster: { bytes: 5242881, sha256: SHA("c"), mime: "image/png" } })],
  ["captions too large", entry("installer", { captions: { bytes: 1048577, sha256: SHA("b"), mime: "text/vtt" } })],
  ["client-chosen path", entry("installer", { videoPath: "installer/en/v1/walkthrough.mp4" })],
  ["version zero", entry("installer", { version: 0 })],
  ["version string", entry("installer", { version: "2" })],
];
await as("owner");
for (const [why, e] of malformed) {
  await rejectsWith(() => reserve(e), "22023", `refused: ${why}`);
}
await rejectsWith(() => db.query("select public.app_training_import_reserve(null, $1::jsonb)", [JSON.stringify(entry("installer"))]), "22023", "refused: no request id");
await rejectsWith(() => db.query("select public.app_training_import_reserve($1, '[]'::jsonb)", [newReq()]), "22023", "refused: array entry");
await rejectsWith(() => reserve(entry("installer", { version: 1 })), "23505", "refused: an existing version");
await asRoot();
assert.equal((await db.query("select count(*)::int n from app_training_imports")).rows[0].n, 0, "no refused reservation left a row");

// ---- reserve, allocate, retry ----------------------------------------------
await as("offTodayOwner");
const offToday = await reserve(entry("installer"));
assert.equal(offToday.version, 2, "an owner who is off today can still import; v1 exists so v2 is next");
assert.deepEqual(offToday.assets.map((a) => a.path), [
  "installer/en/v2/walkthrough.mp4", "installer/en/v2/captions.vtt", "installer/en/v2/poster.jpg",
], "the server chooses the paths");
await as("owner");
const req = newReq();
const ownerInstaller = await reserve(entry("installer"), req);
assert.equal(ownerInstaller.version, 3, "a second reservation gets the next version, never a shared one");
assert.equal((await reserve(entry("installer"), req)).id, ownerInstaller.id, "the same request again returns the same reservation");
await rejectsWith(
  () => reserve(entry("installer", { video: { bytes: 1001, sha256: SHA("d"), mime: "video/mp4" } }), req),
  "22023", "the same request id with different files is refused",
);
await rejectsWith(() => reserve(entry("installer", { version: 3 })), "23505", "a reserved version cannot be requested again");
const v9 = await reserve(entry("foreman", { version: 9, poster: null }));
assert.equal(v9.version, 9, "a higher explicit version is honoured");
assert.equal(v9.assets.length, 2, "no poster, no poster path");
for (const person of ["supervisor", "admin", "bigBoss"]) {
  await as(person);
  await reserve(entry("leadership"));
}

// ---- the upload door ---------------------------------------------------------
const [ownerVideo, ownerCaptions, ownerPoster] = ownerInstaller.assets;
await rejectsWith(() => upload("supervisor", ownerVideo.path, 1000, "video/mp4"), null, "another supervisor cannot upload to the owner's reserved path");
await rejectsWith(() => upload("installer", ownerVideo.path, 1000, "video/mp4"), null, "an installer cannot upload to a reserved path");
await rejectsWith(() => upload("owner", "installer/en/v1/walkthrough.mp4", 1000, "video/mp4"), null, "nobody uploads onto a published path");
await rejectsWith(() => upload("owner", "installer/en/v3/extra.mp4", 1000, "video/mp4"), null, "an unreserved name in a reserved version is refused");
await rejectsWith(() => upload("owner", "leadership/en/v7/walkthrough.mp4", 1000, "video/mp4"), null, "an unreserved version is refused");
const up = await upload("owner", ownerVideo.path, 1000, "video/mp4");
assert.equal(up.rows[0].name, ownerVideo.path, "the owner uploads to its own reserved path, RETURNING included");
await rejectsWith(() => upload("owner", ownerVideo.path, 1000, "video/mp4"), null, "a second upload to the same path is refused (no overwrite)");
await as("owner");
assert.equal((await db.query("update storage.objects set metadata = '{}'::jsonb where name = $1", [ownerVideo.path])).affectedRows ?? 0, 0, "no update");
assert.equal((await db.query("delete from storage.objects where name = $1", [ownerVideo.path])).affectedRows ?? 0, 0, "no delete");
assert.equal((await db.query("select name from storage.objects where name = $1", [ownerVideo.path])).rows.length, 1, "the uploader sees its own staged file");
await as("installer");
assert.equal((await db.query("select name from storage.objects where name = $1", [ownerVideo.path])).rows.length, 0, "an installer cannot see a staged file");
await as("supervisor");
assert.equal((await db.query("select name from storage.objects where name = $1", [ownerVideo.path])).rows.length, 0, "another supervisor cannot see it either");
await as(null);
await rejectsWith(() => db.query("insert into storage.objects(bucket_id,name) values('app-training',$1)", [ownerCaptions.path]), null, "anonymous cannot upload");

// Status reports storage's own facts.
await as("owner");
const st = (await status([ownerInstaller.id]))[0];
assert.deepEqual(st.assets.map((a) => [a.kind, a.present, a.ownedByYou, a.storedBytes]), [
  ["video", true, true, 1000], ["captions", false, false, null], ["poster", false, false, null],
]);
await as("supervisor");
assert.deepEqual(await status([ownerInstaller.id]), [], "someone else's reservation reads as absent");

// ---- publication refuses, and changes nothing, when anything is off ---------
await as("owner");
await rejectsWith(() => publish([ownerInstaller.id]), "22023", "missing captions and poster: refused");
assert.deepEqual(await activeVersions(), { foreman: 1, installer: 1, leadership: 1 }, "the old walkthrough is still on");
// Wrong byte count, as storage recorded it.
await upload("owner", ownerCaptions.path, 99, "text/vtt");
await upload("owner", ownerPoster.path, 50, "image/jpeg");
await as("owner");
await rejectsWith(() => publish([ownerInstaller.id]), "22023", "a short captions file is refused");
assert.deepEqual(await activeVersions(), { foreman: 1, installer: 1, leadership: 1 });
// Someone else's object at the path (only the service key could put it there).
await as("owner");
const foreignR = await reserve(entry("foreman"));
await asService();
for (const a of foreignR.assets) {
  await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) values('app-training',$1,$2,jsonb_build_object('size',$3::bigint,'mimetype',$4::text))",
    [a.path, uid(PEOPLE.supervisor.n), a.bytes, a.mime]);
}
await as("owner");
await rejectsWith(() => publish([foreignR.id]), "22023", "an object the caller did not upload is not accepted as theirs");
// Wrong type.
const typeR = await reserve(entry("leadership", { poster: null }));
await upload("owner", typeR.assets[0].path, 1000, "video/mp4");
await upload("owner", typeR.assets[1].path, 100, "text/plain");
await as("owner");
await rejectsWith(() => publish([typeR.id]), "22023", "a stored type that differs is refused");

// ---- a clean batch --------------------------------------------------------
await as("owner");
const good = { installer: await reserve(entry("installer")), foreman: await reserve(entry("foreman")) };
await uploadAll("owner", good.installer);
await uploadAll("owner", good.foreman, ["poster"]);
await as("owner");
const before = await catalogCount();
await as("owner");
await rejectsWith(() => publish([good.installer.id, good.foreman.id]), "22023", "one missing poster refuses the whole batch");
assert.deepEqual(await activeVersions(), { foreman: 1, installer: 1, leadership: 1 }, "…and the installer half did not go live either");
assert.equal(await catalogCount(), before);
await upload("owner", good.foreman.assets[2].path, 50, "image/jpeg");
await as("owner");
const out = await publish([good.installer.id, good.foreman.id]);
assert.deepEqual(out.map((o) => [o.slug, o.version, o.active, o.alreadyPublished]), [
  ["foreman", good.foreman.version, true, false], ["installer", good.installer.version, true, false],
]);
assert.deepEqual(await activeVersions(), { foreman: good.foreman.version, installer: good.installer.version, leadership: 1 });
await asRoot();
const pubRow = (await db.query("select id, content_status, video_path from app_training_videos where id = $1", [good.installer.id])).rows[0];
assert.equal(pubRow.content_status, "proposal", "published as a design preview");
assert.equal(pubRow.video_path, good.installer.assets[0].path);
// Crews now see the new version, and not the old one.
await as("installer");
const seen = (await db.query("select name from storage.objects where bucket_id='app-training' order by name")).rows.map((r) => r.name);
assert(seen.includes(good.installer.assets[0].path), "the installer can play the new version");
assert(!seen.includes("installer/en/v1/walkthrough.mp4"), "the old version is switched off");
assert(!seen.some((n) => n.startsWith("foreman/")), "floors still hold");

// Idempotent: a retried publish returns the same records and adds nothing.
await as("owner");
const count = await catalogCount();
await as("owner");
const again = await publish([good.installer.id, good.foreman.id]);
assert(again.every((o) => o.alreadyPublished && o.active), "a repeat publish reports the existing records");
assert.equal(await catalogCount(), count, "no second row");
// A published path is closed for good.
await rejectsWith(() => upload("owner", `${good.installer.assets[0].path}`, 1000, "video/mp4"), null, "a published path takes no upload");
await as("owner");
await rejectsWith(() => db.query("select public.app_training_import_cancel($1)", [good.installer.id]).then(async (r) => {
  if (r.rows[0].app_training_import_cancel.state !== "published") throw new Error("cancel changed a published import");
  throw Object.assign(new Error("ok"), { code: "OK" });
}), "OK", "cancelling a published import changes nothing");
assert.deepEqual(await activeVersions(), { foreman: good.foreman.version, installer: good.installer.version, leadership: 1 });

// ---- expired and cancelled -----------------------------------------------
await as("owner");
const exp = await reserve(entry("installer"));
await asRoot();
await db.query("update app_training_imports set expires_at = now() - interval '1 minute' where id = $1", [exp.id]);
await rejectsWith(() => upload("owner", exp.assets[0].path, 1000, "video/mp4"), null, "an expired reservation takes no upload");
await as("owner");
await rejectsWith(() => publish([exp.id]), "22023", "an expired reservation cannot publish");
const can = await reserve(entry("installer"));
await uploadAll("owner", can, ["poster"]);
await as("supervisor");
await rejectsWith(() => db.query("select public.app_training_import_cancel($1)", [can.id]), "P0002", "nobody cancels somebody else's import");
await as("owner");
assert.equal((await db.query("select public.app_training_import_cancel($1) r", [can.id])).rows[0].r.state, "cancelled");
await rejectsWith(() => upload("owner", can.assets[2].path, 50, "image/jpeg"), null, "a cancelled reservation takes no upload");
await as("owner");
await rejectsWith(() => publish([can.id]), "22023", "a cancelled reservation cannot publish");
await asRoot();
assert.equal((await db.query("select count(*)::int n from storage.objects where name = any($1)", [[can.assets[0].path, can.assets[1].path]])).rows[0].n, 2,
  "cancelling deletes nothing that was uploaded");
await as("owner");
const next = await reserve(entry("installer"));
assert(next.version > can.version, "a cancelled version number is never handed out again");

// ---- a stale tab never overrides a newer publication ----------------------
await as("supervisor");
const older = await reserve(entry("leadership"));
await uploadAll("supervisor", older);
await as("supervisor2");
const newer = await reserve(entry("leadership"));
await uploadAll("supervisor2", newer);
await as("supervisor2");
await publish([newer.id]);
await as("supervisor");
await rejectsWith(() => publish([older.id]), "22023", "publishing an older version over a newer one is refused");
assert.equal((await activeVersions()).leadership, newer.version, "the newer walkthrough stays on");
await as("supervisor");
await rejectsWith(() => publish([newer.id]), "P0002", "one supervisor cannot publish another's reservation");

// ---- permissions are asked again at publication ----------------------------
await as("laterRevoked");
const lr = await reserve(entry("foreman"));
await uploadAll("laterRevoked", lr);
await asRoot();
await db.query("update profiles set access_revoked_at = now() where id = $1", [uid(PEOPLE.laterRevoked.n)]);
await as("laterRevoked");
await rejectsWith(() => publish([lr.id]), "42501", "a login switched off after reserving cannot publish");
await rejectsWith(() => upload("laterRevoked", "foreman/en/v99/walkthrough.mp4", 1, "video/mp4"), null);

// ---- a deleted person leaves no dangling id, and no reusable version -------
await as("admin");
const gone = await reserve(entry("installer"));
await asRoot();
await db.query("delete from profiles where id = $1", [uid(PEOPLE.admin.n)]);
const goneRow = (await db.query("select actor_id, state, version from app_training_imports where id = $1", [gone.id])).rows[0];
assert.equal(goneRow.actor_id, null, "the reservation outlives the profile without its id");
assert.equal(goneRow.version, gone.version, "…and keeps its version");
await as("owner");
assert(( await reserve(entry("installer"))).version > gone.version, "that version is still never handed out again");
await rejectsWith(() => publish([gone.id]), "P0002", "an orphaned reservation belongs to nobody");
await rejectsWith(() => upload("owner", gone.assets[0].path, 1000, "video/mp4"), null, "and takes no upload");

// ---- no direct writes, and the catalog guard still holds -------------------
for (const person of ["installer", "owner"]) {
  await as(person);
  await rejectsWith(() => db.query("select id from app_training_imports"), "42501", `${person} cannot read staging`);
  await rejectsWith(() => db.query("update app_training_imports set state='published'"), "42501", `${person} cannot write staging`);
  await rejectsWith(() => db.query(`insert into app_training_videos(slug,min_role,version,title,language,content_status,duration_seconds,video_path,chapters)
    values ('installer','installer',50,'x','en','proposal',10,'installer/en/v50/walkthrough.mp4','[{"seconds":0,"title":"a","status":"live"}]')`), "42501", `${person} cannot write the catalog`);
  await rejectsWith(() => db.query("update app_training_videos set active=false"), "42501", `${person} cannot switch a walkthrough off`);
}
await asService();
await rejectsWith(() => db.query("update app_training_videos set title='changed' where id=$1", [good.installer.id]), null, "an imported row is as immutable as any other");

// ---- with an older, over-broad storage policy in place ---------------------
await asRoot();
await db.exec("create policy fixture_existing_storage on storage.objects for all to authenticated, anon using (true) with check (true)");
await rejectsWith(() => upload("installer", next.assets[0].path, 1000, "video/mp4"), null, "legacy policy: an installer still cannot upload");
await rejectsWith(() => upload("owner", "installer/en/v1/walkthrough.mp4", 1, "video/mp4"), null, "legacy policy: still no upload onto a published path");
await as("owner");
assert.equal((await db.query("delete from storage.objects where bucket_id='app-training'")).affectedRows ?? 0, 0, "legacy policy: still no delete");
assert.equal((await db.query("update storage.objects set name='x' where bucket_id='app-training'")).affectedRows ?? 0, 0, "legacy policy: still no rename");
await upload("installer", "installer.png", 1, "image/png", "other-bucket");
await as(null);
await db.query("insert into storage.objects(bucket_id,name) values('other-bucket','anon.png')");
assert.equal((await db.query("select name from storage.objects where bucket_id='other-bucket'")).rows.length, 2, "other buckets untouched, anon included");
await upload("owner", next.assets[0].path, 1000, "video/mp4");

console.log(
  "App training importer: supervisor/owner-only from the real profile (off-today allowed; anonymous, installer, foreman, partner, revoked, retired, unknown and profile-less refused), strict reservations, locked versions, reserved-path-only uploads with no overwrite/update/delete, storage-verified all-or-nothing publication that never hides the old version on failure or overrides a newer one, idempotent retry, and closed staging/catalog tables passed.",
);
await db.close();
