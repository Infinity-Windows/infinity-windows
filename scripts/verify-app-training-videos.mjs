// The actual "Using Forge" walkthrough migration, replayed in a disposable
// PostgreSQL under every kind of caller. No live records, no network.
//
//   PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js \
//     node scripts/verify-app-training-videos.mjs
//
// What it proves (docs/role-training-videos.md, "Authorization"):
//   - catalog rows AND storage objects follow the role floors from the REAL
//     profile row: installer 0+, foreman 1+, leadership 2+, legacy aliases too
//   - anonymous, partner, switched-off, Removed, unknown-role and profile-less
//     logins see nothing; "off today" (active = false) still sees its videos
//   - an installer asking for the leadership object by its exact name, or for
//     an uploaded-but-unpublished object, gets nothing
//   - drafts, switched-off versions and future publications are hidden
//   - no browser role can write a catalog row or a storage object, even with
//     an older permissive storage policy in place, and other buckets are
//     untouched by the new walls (anonymous reads of them still work)
//   - published rows are immutable, and the shape checks refuse bad paths,
//     mismatched floors and broken chapter lists
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
  offToday: { n: 8, role: "installer", active: false },
  partner: { n: 9, role: "installer", is_partner: true },
  revokedOwner: { n: 10, role: "owner", access_revoked_at: "now()" },
  retiredOwner: { n: 11, role: "owner", retired_at: "now()" },
  unknownRole: { n: 12, role: "contractor" },
};

await db.exec(`
create role authenticated; create role anon; create role service_role bypassrls;
create schema auth; create schema storage;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public, auth, storage to authenticated, anon, service_role;
create table profiles(id uuid primary key, role text, active boolean default true, is_partner boolean default false, retired_at timestamptz, access_revoked_at timestamptz);
create function role_rank(p_role text) returns int language sql immutable as $$
  select case p_role when 'owner' then 3 when 'big_boss' then 3 when 'supervisor' then 2 when 'admin' then 2 when 'foreman' then 1 when 'lead' then 1 else 0 end $$;
create function my_role_rank() returns int language sql stable security definer as $$select role_rank((select role from profiles where id=auth.uid()))$$;
grant execute on function my_role_rank() to authenticated;
create function is_partner_user() returns boolean language sql stable security definer as $$select coalesce((select is_partner from profiles where id=auth.uid()),false)$$;
grant execute on function is_partner_user() to authenticated;
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
-- An older, over-broad storage policy of the kind the restrictive walls exist
-- to survive: every signed-in or anonymous caller, every bucket, every verb.
grant select, insert, update, delete on storage.objects to authenticated, anon, service_role;
create policy fixture_existing_storage on storage.objects for all to authenticated, anon using (true) with check (true);
`);
for (const [, p] of Object.entries(PEOPLE)) {
  await db.query(
    `insert into profiles(id, role, active, is_partner, retired_at, access_revoked_at)
     values ($1, $2, $3, $4, ${p.retired_at ?? "null"}, ${p.access_revoked_at ?? "null"})`,
    [uid(p.n), p.role, p.active ?? true, p.is_partner ?? false],
  );
}

// An accidental preexisting public bucket must be made private, not silently kept.
await db.exec("insert into storage.buckets(id,name,public) values('app-training','app-training',true)");
await db.exec(
  await readFile(new URL("../supabase/migrations/20261025000000_app_training_videos.sql", import.meta.url), "utf8"),
);
assert.equal((await db.query("select public from storage.buckets where id='app-training'")).rows[0].public, false);
// A replay must be harmless: the next `supabase db push` after a partial
// failure runs the whole file again.
await db.exec(
  await readFile(new URL("../supabase/migrations/20261025000000_app_training_videos.sql", import.meta.url), "utf8"),
);

async function asService() {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub','',false)");
  await db.exec("set role service_role");
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

const chapters = (d) => JSON.stringify([
  { seconds: 0, title: "Start of the day", status: "live" },
  { seconds: Math.floor(d / 2), title: "Proposed flow", status: "proposal" },
]);
function row(slug, minRole, version, extra = {}) {
  const base = `${slug}/en/v${version}`;
  return {
    slug, min_role: minRole, version, title: `${slug} walkthrough`, language: "en",
    content_status: "proposal", duration_seconds: 300,
    video_path: `${base}/walkthrough.mp4`, captions_path: `${base}/captions.vtt`,
    poster_path: `${base}/poster.jpg`, transcript_text: "Narration text.",
    chapters: chapters(300), published_at: "now()", active: true, ...extra,
  };
}
async function insertRow(r) {
  await db.query(
    `insert into app_training_videos(slug,min_role,version,title,language,content_status,duration_seconds,video_path,captions_path,poster_path,transcript_text,chapters,published_at,active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,${r.published_at === null ? "null" : r.published_at === "future" ? "now() + interval '1 day'" : "now()"},$13)`,
    [r.slug, r.min_role, r.version, r.title, r.language, r.content_status, r.duration_seconds,
      r.video_path, r.captions_path, r.poster_path, r.transcript_text, r.chapters, r.active],
  );
}

// ---- seed, as the publisher would ----------------------------------------
await asService();
await insertRow(row("installer", "installer", 1));
await insertRow(row("foreman", "foreman", 1));
await insertRow(row("leadership", "supervisor", 1));
// A leadership draft awaiting publication, and a foreman version scheduled
// for tomorrow.
await insertRow(row("leadership", "supervisor", 2, { published_at: null, active: false }));
await insertRow(row("foreman", "foreman", 2, { published_at: "future", active: false }));
for (const name of [
  "installer/en/v1/walkthrough.mp4", "installer/en/v1/captions.vtt", "installer/en/v1/poster.jpg",
  "foreman/en/v1/walkthrough.mp4", "foreman/en/v1/captions.vtt",
  "leadership/en/v1/walkthrough.mp4", "leadership/en/v1/captions.vtt",
  "leadership/en/v2/walkthrough.mp4", // uploaded, never published
  "leadership/en/v1/stray-upload.mp4", // in the bucket, named by no row
]) {
  await db.query("insert into storage.objects(bucket_id,name) values('app-training',$1)", [name]);
}
await db.query("insert into storage.objects(bucket_id,name) values('other-public',$1)", ["logo.png"]);
await db.exec("reset role");
assert.equal(
  (await db.query("select public from storage.buckets where id='app-training'")).rows[0].public,
  false,
  "the bucket is private",
);

const COLS = "slug,title,min_role,language,content_status,version,duration_seconds,video_path,captions_path,poster_path,transcript_text,chapters,published_at,active";
async function slugs() {
  return (await db.query(`select ${COLS} from app_training_videos order by slug`)).rows.map((r) => r.slug);
}
async function objects() {
  return (await db.query("select name from storage.objects where bucket_id='app-training' order by name")).rows.map((r) => r.name);
}

// ---- role floors, from the real profile row -------------------------------
const EXPECT = {
  installer: ["installer"],
  offToday: ["installer"],
  foreman: ["foreman", "installer"],
  lead: ["foreman", "installer"],
  supervisor: ["foreman", "installer", "leadership"],
  admin: ["foreman", "installer", "leadership"],
  owner: ["foreman", "installer", "leadership"],
  bigBoss: ["foreman", "installer", "leadership"],
  partner: [],
  revokedOwner: [],
  retiredOwner: [],
  unknownRole: [],
};
for (const [person, want] of Object.entries(EXPECT)) {
  await as(person);
  assert.deepEqual(await slugs(), want, `${person} reads the catalog floors`);
  const names = await objects();
  const allowedPrefixes = want.map((s) => `${s}/en/v1/`);
  for (const name of names) {
    assert(allowedPrefixes.some((p) => name.startsWith(p)), `${person} must not read ${name}`);
  }
  assert(!names.includes("leadership/en/v2/walkthrough.mp4"), `${person}: unpublished object hidden`);
  assert(!names.includes("leadership/en/v1/stray-upload.mp4"), `${person}: uncatalogued object hidden`);
  if (want.includes("installer")) assert(names.includes("installer/en/v1/walkthrough.mp4"), `${person} reads its video`);
}

// The exact thing the task names: an installer asking for the leadership
// video by its exact object name, the way createSignedUrl would.
await as("installer");
assert.equal(
  (await db.query("select name from storage.objects where bucket_id='app-training' and name='leadership/en/v1/walkthrough.mp4'")).rows.length,
  0,
  "installer cannot resolve the leadership object by guessing its name",
);
assert.equal(
  (await db.query("select public.can_read_app_training_object('leadership/en/v1/walkthrough.mp4') ok")).rows[0].ok,
  false,
);
// ...nor read the catalog around the policy with a direct filter.
assert.equal((await db.query(`select ${COLS} from app_training_videos where slug='leadership'`)).rows.length, 0);
// `select *` is refused outright: created_at is not granted, so the client
// has to name its columns (and cannot widen them by accident).
await assert.rejects(() => db.query("select * from app_training_videos"));

// Anonymous and profile-less.
await as(null);
await assert.rejects(() => db.query(`select ${COLS} from app_training_videos`), "anon has no grant on the catalog");
assert.deepEqual(await objects(), [], "anon reads no app-training object");
assert.equal(
  (await db.query("select name from storage.objects where bucket_id='other-public'")).rows.length,
  1,
  "the anon wall leaves other buckets readable (no function call it cannot execute)",
);
await asStranger();
assert.deepEqual(await slugs(), [], "a signed-in id with no profile sees nothing");
assert.deepEqual(await objects(), []);

// ---- zero client writes ---------------------------------------------------
for (const person of ["installer", "owner"]) {
  await as(person);
  await assert.rejects(
    () => db.query(`insert into app_training_videos(slug,min_role,version,title,language,content_status,duration_seconds,video_path,chapters)
      values ('installer','installer',9,'x','en','proposal',10,'installer/en/v9/x.mp4','[{"seconds":0,"title":"a","status":"live"}]')`),
    `${person} cannot insert a catalog row`,
  );
  await assert.rejects(() => db.query("update app_training_videos set active=false"), `${person} cannot update`);
  await assert.rejects(() => db.query("delete from app_training_videos"), `${person} cannot delete`);
  await assert.rejects(
    () => db.query("insert into storage.objects(bucket_id,name) values('app-training','installer/en/v1/walkthrough.mp4')"),
    `${person} cannot upload, even with an older permissive policy`,
  );
  await assert.rejects(
    () => db.query("insert into storage.objects(bucket_id,name) values('app-training','installer/en/v7/new.mp4')"),
  );
  const upd = await db.query("update storage.objects set name='x' where bucket_id='app-training'");
  assert.equal(upd.affectedRows ?? 0, 0, `${person} cannot rename or replace an object`);
  const del = await db.query("delete from storage.objects where bucket_id='app-training'");
  assert.equal(del.affectedRows ?? 0, 0, `${person} cannot delete an object`);
  // Other buckets still behave as the older policy says.
  await db.query("insert into storage.objects(bucket_id,name) values('other-public',$1)", [`${person}.png`]);
}
await as(null);
await assert.rejects(() => db.query("insert into storage.objects(bucket_id,name) values('app-training','installer/en/v8/a.mp4')"));
await asService();
assert.equal(
  (await db.query("select count(*)::int n from storage.objects where bucket_id='app-training'")).rows[0].n,
  9,
  "every original object is still there, unchanged",
);

// ---- shape and immutability, even for the service key ---------------------
// SQL missing properties are NULL, unlike explicit JSON null. Check the actual
// validator so a separate unique-active constraint cannot mask a broken check.
for (const c of [
  [{status:"live"}], [{seconds:0,status:"live"}],
  [{title:"Missing seconds",status:"proposal"}],
  [{seconds:null,title:"Null seconds",status:"proposal"}],
  [{seconds:0,title:null,status:"proposal"}],
  [{seconds:0,title:"Missing status"}],
]) {
  assert.equal((await db.query("select app_training_chapters_valid($1::jsonb,300) as ok",[JSON.stringify(c)])).rows[0].ok, false);
}

const bad = [
  ["floor/slug mismatch", row("leadership", "installer", 5)],
  ["foreman floor on installer slug", row("installer", "foreman", 5)],
  ["path outside its version", row("installer", "installer", 5, { video_path: "installer/en/v4/walkthrough.mp4" })],
  ["path into another walkthrough", row("installer", "installer", 5, { captions_path: "leadership/en/v5/captions.vtt" })],
  ["traversal", row("installer", "installer", 5, { video_path: "installer/en/v5/../../leadership/en/v1/walkthrough.mp4" })],
  ["wrong video type", row("installer", "installer", 5, { video_path: "installer/en/v5/walkthrough.mov" })],
  ["wrong captions type", row("installer", "installer", 5, { captions_path: "installer/en/v5/captions.srt" })],
  ["unknown content status", row("installer", "installer", 5, { content_status: "draft" })],
  ["first chapter not at 0", row("installer", "installer", 5, { chapters: JSON.stringify([{ seconds: 5, title: "a", status: "live" }]) })],
  ["chapter past the end", row("installer", "installer", 5, { chapters: JSON.stringify([{ seconds: 0, title: "a", status: "live" }, { seconds: 300, title: "b", status: "live" }]) })],
  ["chapters out of order", row("installer", "installer", 5, { chapters: JSON.stringify([{ seconds: 0, title: "a", status: "live" }, { seconds: 60, title: "b", status: "live" }, { seconds: 30, title: "c", status: "live" }]) })],
  ["unknown chapter status", row("installer", "installer", 5, { chapters: JSON.stringify([{ seconds: 0, title: "a", status: "shipped" }]) })],
  ["empty chapter title", row("installer", "installer", 5, { chapters: JSON.stringify([{ seconds: 0, title: " ", status: "live" }]) })],
  ["chapter without seconds", row("installer", "installer", 5, { chapters: JSON.stringify([{ seconds: 0, title: "a", status: "live" }, { title: "b", status: "live" }]) })],
  ["chapter without a title", row("installer", "installer", 5, { chapters: JSON.stringify([{ seconds: 0, status: "live" }]) })],
  ["no chapters", row("installer", "installer", 5, { chapters: "[]" })],
  ["active but unpublished", row("installer", "installer", 5, { published_at: null, active: true })],
  ["second active copy", row("installer", "installer", 5)],
  ["same version twice", row("installer", "installer", 1, { active: false })],
];
for (const [why, r] of bad) {
  await asService();
  // Most cases test shape, so do not also violate the one-active-version index.
  // Otherwise invalid JSON would appear rejected even when its CHECK passed.
  if (!["active but unpublished", "second active copy", "same version twice"].includes(why)) r.active = false;
  await assert.rejects(() => insertRow(r), `refused: ${why}`);
}
await asService();
await assert.rejects(() => db.query("update app_training_videos set title='changed' where slug='installer'"), "published title is immutable");
await assert.rejects(() => db.query("update app_training_videos set video_path='installer/en/v1/other.mp4' where slug='installer'"), "paths are immutable");
await assert.rejects(() => db.query("update app_training_videos set published_at=now() - interval '1 day' where slug='installer'"), "published_at stamped once");
await assert.rejects(() => db.query("delete from app_training_videos where slug='installer'"), "published rows are never deleted");
// What IS allowed: switching a version off, and deleting a never-published draft.
await db.query("update app_training_videos set active=false where slug='installer' and version=1");
await db.query("delete from app_training_videos where slug='leadership' and version=2");
await as("installer");
assert.deepEqual(await slugs(), [], "a switched-off version disappears from the catalog");
assert.deepEqual(await objects(), [], "...and its objects stop being signable");

// The crew announcement applies on top of the real release-notes table and
// reaches every crew role (it is about a tab every role has).
await db.exec("reset role");
for (const file of ["20261021000000_role_scoped_app_updates.sql", "20261025020000_app_training_videos_note.sql"]) {
  await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"));
}
await db.exec("update app_release_notes set published_on=current_date where id='2026-09-23-using-forge-previews'");
for (const person of ["installer", "foreman", "supervisor", "owner"]) {
  await as(person);
  assert.equal(
    (await db.query("select id from app_release_notes where id='2026-09-23-using-forge-previews'")).rows.length,
    1,
    `${person} is told about the tab`,
  );
}
await as("partner");
assert.equal((await db.query("select id from app_release_notes where id='2026-09-23-using-forge-previews'")).rows.length, 0);

// A scheduled publication stays hidden until its moment, even switched on.
await asService();
await db.query("update app_training_videos set active=false where slug='foreman' and version=1");
await db.query("update app_training_videos set active=true where slug='foreman' and version=2");
await as("owner");
assert.deepEqual(await slugs(), ["leadership"], "a future publication is hidden even when active");

console.log(
  "App training videos: role floors from the real profile, aliases, off-today access, partner/revoked/retired/unknown/anonymous denial, guessed and unpublished objects hidden, zero client writes under a permissive legacy policy, immutable published rows, shape checks and the crew announcement passed.",
);
await db.close();
