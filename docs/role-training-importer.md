# Publishing "Using Forge" walkthroughs from the app

A supervisor or owner, signed in to the ordinary app on a computer, publishes
reviewed walkthrough videos without a service key. This is the product path;
the local package checker in [role-training-videos.md](role-training-videos.md)
validates files only and cannot publish.

| Piece | File |
| --- | --- |
| Server lock | `supabase/migrations/20261025010000_app_training_importer.sql` |
| Client rules | `app/src/lib/trainingImport.ts` (+ `.test.ts`) |
| Screen | `app/src/components/learn/TrainingImporter.tsx`, `trainingImporterCopy.ts`, `trainingImporter.css` |
| Server proof | `scripts/verify-app-training-importer.mjs` |

## Steps for the person publishing

1. Open **Learn → Using Forge** on a computer. The **Publish walkthrough videos**
   panel appears only for supervisors and owners, and not while previewing a
   lower role.
2. **Choose manifest:** the reviewed `role-videos-manifest.json`.
3. **Choose files:** every video, caption, transcript and poster it names
   (you can pick them together or pick the whole folder).
4. Read the preview. Nothing has been sent yet. Each card shows the role, title,
   version (or "Next version"), length, English narration, chapter, caption and
   transcript counts, the files and their sizes, and the **Design preview**
   badge.
5. Tap **Publish reviewed walkthroughs** and keep the page open. The panel
   says **Published** only after the server has confirmed the switch.

If it stops (signal, timeout, **Stop**), the panel says **Publication not
confirmed**, not "nothing was published": the server may have committed just
before the answer was lost. Your chosen files stay selected. Tap **Try again**
to check. You get the same versions back, files that already arrived aren't
uploaded again, and a publication that already went through comes back as
"already published" rather than being made twice. **Give up these reserved
versions** closes the upload door on anything not yet published and reports
any that had already been published. It deletes nothing.

Some errors need **Start over with new versions**: the reservation expired or
was given up, the files changed, a stored file didn't match, or someone
published a newer version first.

## The manifest

The canonical shape is `{ "videos": [ entry, … ] }`. A bare array of entries
also works. Nothing else is accepted. The manifest can list one, two or all
three walkthroughs. If any row is invalid, the whole manifest is rejected and
none of it is imported.

```json
{
  "videos": [{
    "slug": "installer",              // installer | foreman | leadership
    "minRole": "installer",           // installer | foreman | supervisor — must match slug
    "title": "…",                     // 1–160 characters
    "language": "en",                 // English narration only, for now
    "contentStatus": "proposal",      // the importer never publishes "live"
    "durationSeconds": 312,           // whole seconds, 1–7200, within 2 s of the file's own length
    "version": 2,                     // optional; left out, the server picks the next free one
    "videoFile": "installer-tour.mp4",
    "captionsFile": "installer-tour.vtt",
    "transcriptFile": "installer-transcript.json",
    "posterFile": "installer-poster.jpg",   // optional
    "chapters": [{ "seconds": 0, "title": "…", "status": "proposal" }]  // proposal | live | mixed
  }]
}
```

(The comments are only here to explain the fields. A real manifest is plain
JSON, and any key not shown above is rejected.)

File names must be plain relative names: no web address, no absolute path, no
backslash, no `..`. Each one has to match exactly one chosen file. If two
chosen files have the same name, the importer uses the folder path to tell
them apart. If that still doesn't settle it, the import is refused rather
than guessing.

| File | Checked on this computer |
| --- | --- |
| Video | `.mp4` with an `ftyp` header, 1 byte to 45 MiB, and a length this browser can read that agrees with `durationSeconds` |
| Captions | WebVTT header, at least one cue with words, and every cue time well-formed and inside the video (1 MiB max) |
| Transcript | `{ "language": "en", "segments": [{ "startSeconds", "endSeconds", "text" }] }`, with finite, ordered times inside the video and non-empty text (1 MiB max) |
| Poster | JPEG, PNG or WebP. The real type, read from the bytes, must match the extension (5 MiB max) |

The transcript is flattened to plain text, one paragraph per segment, with
every word kept. That text is what the catalog stores. The timed originals
stay on your computer: the importer never uploads the transcript JSON.

## What the server checks

The browser is never trusted. Every check above that matters for safety is
repeated on the server, and the server adds the checks below.

- **Who.** Every function reads the caller's **real** profile through
  `auth.uid()`. A supervisor or owner qualifies (the legacy `admin` and
  `big_boss` too). Partner logins, switched-off logins (`access_revoked_at`),
  Removed ones (`retired_at`) and unknown roles are refused. "Off today"
  (`profiles.active = false`) is still allowed. "View as role" is never
  consulted. The check runs again at publication, so a login switched off
  mid-import can't finish.
- **Reserve** (`app_training_import_reserve`). This validates the entry
  strictly: missing or `null` fields are refusals (`IS DISTINCT FROM`, never
  `<>`), unknown keys are refused, and so is any `contentStatus` other than
  `proposal`. It then takes a per-walkthrough, per-language lock and allocates
  a version above every catalog row and every earlier reservation, cancelled
  ones included. The server picks the paths
  (`<slug>/<lang>/v<N>/walkthrough.mp4`, `captions.vtt`, `poster.<ext>`). It
  records the expected byte counts, types and SHA-256 fingerprints, the actor,
  and a 6-hour expiry. Sending the same `request_id` again returns the same
  reservation. The same id with different files is refused.
- **Upload.** This is the ordinary storage upload, with `x-upsert: false` and
  `cache-control: no-store`, using the person's own token. The storage policy
  admits an INSERT into `app-training` only at a path the caller reserved,
  while it is still reserved and unexpired, and only if no catalog row names
  that path. UPDATE and DELETE stay blocked for every browser role, so nothing
  gets overwritten and `upsert` can't replace anything.
- **Status** (`app_training_import_status`). This reports what storage itself
  recorded for the caller's own reservations: whether each file is present,
  its owner, its size and its type. The client uses it to skip files that
  already arrived and to judge a `409 already exists`. A file the run did not
  itself just store (found there on a retry, or answered 409) is accepted only
  if storage shows this account as the owner with the planned byte count and
  type, **and** its bytes, read back through
  `GET /storage/v1/object/authenticated/…` with the actor's token (capped at
  the expected size, not cached), hash to the planned SHA-256. A same-size
  file with different content is refused.
- **Publish** (`app_training_import_publish`). One to three reservations run
  in one transaction, locked in a fixed order. For every expected object the
  server checks that it exists and that its storage owner, `metadata.size` and
  `metadata.mimetype` match the reservation. It refuses anything expired or
  cancelled, and anything older than the version currently live. It then
  switches the old version off and the new one on. The catalog row's id is the
  reservation's id. **If anything fails, nothing changes**: the old
  walkthrough keeps playing, and the other walkthroughs in the batch don't go
  live either. Publishing again returns the same rows with
  `alreadyPublished: true`.
- **Cancel** (`app_training_import_cancel`). This works only on your own
  reservations while they are still reserved. It closes the upload door and
  touches no object and no catalog row.
- **Closed doors.** Browsers have no grant on `app_training_imports`. The
  catalog's own grants, immutability trigger and path checks are unchanged,
  and imported rows are as immutable as any other. The migration also pins the
  bucket private, with its size and type limits, even if a bucket of that name
  already existed with other settings.

## Limits and assumptions

- **Digest.** Storage doesn't expose a content hash the database can trust
  (multipart uploads have no plain MD5), so the SERVER checks owner, byte
  count and type only. Byte identity is proven by the client: the reservation
  records each file's SHA-256 (a retry with a changed file is refused as
  `request_changed`), and any object the run didn't store itself is read back
  and hashed before it's accepted. A fresh upload answered 200 isn't read back.
- **Upload size bound.** The upload policy checks the reserved path, not the
  size. Storage's permission probe inserts before any bytes exist, so a
  metadata check there would refuse every honest upload. The migration
  lowers the bucket's own ceiling to 45 MiB, which bounds any upload, and
  publication then requires the exact reserved size. The optional
  local package checker uses the same limit.
- **Deleted people.** `actor_id` references `profiles(id)` `ON DELETE SET
  NULL`. A person with no work history is deleted outright
  (`manage-crew-access`, cascading from the auth user). Their reservations
  then keep their version numbers and paths, with no personal id, and can
  never be used again. There is no automatic retention or cleanup of
  reservations.
- **How storage uploads.** This relies on the storage server inserting the
  object row once, as the caller, with `metadata` already filled in and with
  `RETURNING`. That's why the uploader may also SELECT its own staged objects.
  If a storage version wrote metadata with a later UPDATE, uploads would be
  refused, which fails closed. Try one upload on a non-production project
  before relying on a storage upgrade.
- **Orphans.** Files uploaded under a reservation that was cancelled or
  expired stay in the bucket. No catalog row names them and no crew member
  can read them. Nothing deletes them automatically, and no browser can. A
  service-key cleanup is a deliberate, separate job.
- **Nothing kept on the device.** There is no queue, no saved selection, no
  resume after a reload, and no offline copy. Uploads bypass the app's global
  `timedFetch` (they use XMLHttpRequest for progress), so each file has its
  own deadline: 2 minutes plus 1 second per 128 KiB, at most 15 minutes.
  Read-backs use the same deadline. Server calls get 30 seconds each,
  covering the whole response body, each with its own AbortController.
- **Account switch.** The panel is keyed by the signed-in user. Another
  account gets a brand-new panel with none of the previous person's manifest,
  file names, titles, transcript, reservations or results. The old panel's
  unmount aborts its run and ignores every late callback. Within a run, the
  session is read again (bounded, 10 s) before and after every server call,
  and each request carries the token from that check, explicitly. RPCs go
  through `fetch` to `/rest/v1/rpc/…` rather than the shared Supabase
  client, which would attach whoever is signed in when the request leaves.
  Tokens are never logged.
- **Migration order.** This file replaces the base migration's single INSERT
  wall (`app_training_no_client_insert`) with an anon wall and an
  authenticated reserved-path wall, and widens the read wall to include the
  uploader's own staged objects. Re-running *only* the base file afterwards
  would restore the flat wall and block uploads. That fails closed; re-apply
  this file to restore uploads.

## Proving it

```bash
PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js \
  node scripts/verify-app-training-importer.mjs
cd app && npx vitest run src/lib/trainingImport.test.ts src/components/learn/TrainingImporter.test.tsx
```

The SQL proof replays both migrations under every kind of caller (anonymous,
installer, foreman, lead, partner, revoked, retired, unknown role, no profile,
off-today owner, two supervisors). It covers malformed JSON with missing and
null fields, uploads with the wrong actor, onto a published path or onto an
unreserved path, overwrite, update and delete, a missing or mismatched file,
expired and cancelled reservations, revocation between reserving and
publishing, a stale session publishing over a newer version, all-or-nothing
batches, idempotent retry, and an older permissive storage policy. It uses
synthetic data only and needs no network.

## For the host screen

```tsx
const TrainingImporter = lazy(() => import("./TrainingImporter"));
<TrainingImporter key={userId} onPublished={(rows) => …} />  // onPublished optional
```

- **Default export.** It renders nothing unless `useEffectiveRole()` has
  loaded, someone is signed in, and the effective role is supervisor, admin,
  owner or big_boss. It keys its own panel by the signed-in user; a `key` on
  the host is harmless but not needed.
- **After a confirmed publish,** it invalidates the `["appTrainingVideos"]`
  query itself. `onPublished` receives
  `{ id, slug, version, active, alreadyPublished }[]`.
- **What it adds.** No query-key root, no route, no nav entry, no service-worker
  change, and nothing in the entry chunk if it's loaded lazily.
