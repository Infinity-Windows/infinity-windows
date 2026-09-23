# Using Forge walkthrough videos

Status: release candidate. The tab, catalog, bucket and package validator are built and tested locally; no video has been uploaded. Until one is published the tab says "No walkthroughs yet".

Learn → **Using Forge** plays three narrated walkthroughs of **proposed** app designs: installer, foreman, and owner/supervisor ("leadership"). They are design previews, not lessons. Every card and the top of the player say: *Design preview — some steps are proposed, not available in the current app.* Each chapter is tagged Proposed, In the app today, or Partly in the app.

## What watching does NOT do

- No learning time. Learn's page clock pauses while this tab is open (`Education.tsx`), and the player sends no heartbeat.
- No points, quiz result, clearance, toolbox signature, QC or payroll time. Nothing in the feature writes to the database.
- Not an operating instruction. The tab says to keep using the app as it works today, and it keeps real work (clock, units, forms) apart from the videos, with no shortcut buttons.

The existing Videos tab (lessons, quizzes, clearances) and its `learning_videos` table, `learning-videos` bucket and policies are unchanged.

## Who can watch

| Walkthrough | `slug` | `min_role` | Who can watch |
|---|---|---|---|
| Installer | `installer` | `installer` | installer, foreman, supervisor, owner |
| Foreman | `foreman` | `foreman` | foreman, supervisor, owner |
| Owner/supervisor | `leadership` | `supervisor` | supervisor, owner |

Legacy aliases (`lead`, `admin`, `big_boss`) rank like their modern roles.

**Always refused:** anonymous callers, partner (builder) logins, switched-off logins (`access_revoked_at`), Removed logins (`retired_at`), a signed-in id without a profile, and any role the app doesn't recognise. **Still allowed:** `profiles.active = false`. That means "off site today", not a revoked login.

## How access is enforced

Migration `20261025000000_app_training_videos.sql`:

- **Catalog.** `public.app_training_videos` has row-level security. A crew login may read only rows that are switched on (`active`), already published (`published_at <= now()`), and at or below its REAL profile role (`can_watch_app_training`). The partner guard applies. The table grants SELECT on named columns only, so `select *` is refused. Crew logins have no insert, update or delete.
- **Objects.** The private bucket `app-training` holds MP4, WebVTT and poster images; the transcript is stored on the catalog row. A permissive SELECT policy and a **restrictive** SELECT boundary both require `can_read_app_training_object(name)`. That is true only for the exact video, captions or poster path of a published, switched-on row the caller may watch. Guessed paths, uploaded-but-unpublished files and retired versions stay unreadable. Restrictive INSERT, UPDATE and DELETE boundaries block every browser write to the bucket, even if an older, broader storage policy exists. Anonymous callers hit a simple restrictive wall that calls no function, so other buckets are unaffected.
- **Signing.** The phone calls `createSignedUrls` with its own session. Storage signs only objects the caller can SELECT, so the role check runs on the object as well as the row.
- **Preview.** "View as role" narrows the list on screen (`visibleTrainingVideos(…, effectiveRole)`) but can never add a video. Switching the preview to a role that can't see the open video closes it.
- **Immutability.** A trigger allows only `active` to change on a row, plus a one-time `published_at` stamp. It applies to the service key too. Published rows are never deleted. Object names must sit under `<slug>/<language>/v<version>/`, and check constraints enforce the file type and the floor that matches the slug.

## Signed links, caching and shared phones

- Links last **one hour** (`SIGNED_URL_SECONDS`), long enough for normal playback and seeking. A signed link is a **bearer token**: anyone holding it can stream that one file until it expires. Revoking access or switching a row off stops **new** links immediately but does not cancel a link already issued. Removing someone's access therefore takes effect within the hour.
- Links are never stored. They live in component state only. The catalog's query-key root `appTrainingVideos` is registered `offline: false`, so it is never persisted to localStorage. The service worker's image cache skips `app-training` URLs (`lib/privateMedia.ts`), and captions are fetched with `cache: "no-store"`. There is no public or role-shared cache.
- On an account switch, the catalog is keyed by user id and other users' copies are removed. The open player unmounts, its captions blob URL is revoked, and a signature that arrives late for the previous user is discarded.
- Opening a video is bounded. If signing takes more than 30 seconds, the player says the video couldn't be opened and offers Retry. Captions are optional: if the caption file isn't back within 15 seconds (headers and body together), is over 1 MB, or isn't WebVTT, the video plays without it and the transcript still shows. A caption file that arrives late is thrown away. Leaving the player or switching accounts aborts any download still in flight.
- There is no download or offline playback. The tab says the videos play while online. Browsers that honour `controlsList="nodownload"` hide their download button, but that is not a security control.

## Publishing

Nothing is uploaded by the build, and no live publication has happened.

1. **Review the package.** Use the folder the video agent produced (e.g. `../outputs/Forge-Role-Walkthroughs-2026-09-23`). Watch each video. Check that proposed steps are labelled as proposals and that no crew names, customer names, addresses, phone numbers, emails or real job data appear in the video, captions, transcript, titles or chapters.

2. **Validate it locally.** This only reads files. It reads no credentials, makes no network call and writes nothing:

   ```bash
   node scripts/publish-role-walkthroughs.mjs --manifest ../outputs/Forge-Role-Walkthroughs-2026-09-23/role-videos-manifest.json
   ```

   The manifest is the package's own shape, `{ "version": 1, "videos": [ … ] }`. Each entry looks like this:

   ```json
   { "slug": "installer", "title": "…", "minRole": "installer", "language": "en", "version": 1,
     "contentStatus": "proposal", "durationSeconds": 612,
     "videoFile": "installer-tour.mp4", "captionsFile": "installer-tour.vtt",
     "transcriptFile": "installer-transcript.json", "posterFile": "installer-poster.jpg",
     "chapters": [{ "seconds": 0, "title": "…", "status": "live" }] }
   ```

   The transcript file is JSON: `{ "language": "en", "voice"?, "contentStatus"?, "title"?, "segments": [{ "startSeconds", "endSeconds", "text" }] }`. Any other field is refused. The stored transcript keeps every segment's words in order: segments that run on from each other join into one paragraph, and a pause starts a new one.

   The script refuses the whole package if any of these fail:
   - The manifest must be `{ videos: [...] }`, with each slug listed once.
   - `minRole` must match the slug exactly.
   - `contentStatus` must be `proposal`.
   - Paths must be inside the manifest folder, with no links out.
   - File types must be `.mp4`, `.vtt`, `.json` and `.jpg`/`.png`/`.webp`, and each file's bytes must match its type.
   - Size limits: video 45 MiB, captions 1 MiB, poster 5 MB, transcript 200,000 characters.
   - Chapters, captions and transcript segments must stay inside the video, in order.
   - No email address or phone number may appear in the transcript, captions, title or chapters.

   It prints each file's object name under `<slug>/<language>/v<version>/`.

3. **Check the project's global upload limit** (Supabase → Storage → Settings). If it is below a video's size, the upload fails. Raise the limit or re-encode the video; don't shrink the bucket rules.

4. **Apply the migrations** through the normal release (`20261025000000` for the catalog, `20261025010000` for the importer, then `20261025020000` for the crew note).

5. **Publish through the in-app importer.** A supervisor or owner signs in to the app. See [the importer runbook](role-training-importer.md). Its server functions re-check the package and switch the old version off and the new one on in one transaction. There is no service-key or production shortcut. `--apply` on the script is retired, and it now exits without doing anything: its old path switched versions over in separate calls, and a failure between them could leave no walkthrough live.

6. **Verify** as an installer, a foreman and a supervisor (or owner with preview). Check each sees the right shelf, then check captions, a chapter jump, the transcript and the phone layout.

### Corrections and removal

- **Correcting a video:** publish a new version. The old files and row remain and are simply switched off. Published rows and objects are never changed or deleted.
- **Removing a video:** switch it off. New signing stops at once, and links already issued expire within the hour.

## Current limits

- English narration and captions only. The interface around them is English and Spanish, and it says the narration is English. A Spanish version would be a separate `language: 'es'` row with its own files.
- Publication runs only through the in-app importer. The local script validates a package but never publishes it.
- There is no viewing record, completion mark or report.
- The player needs signal. Offline, it says so and offers Retry, and it retries automatically when the signal returns.

## Verification

- `PGLITE_MODULE=… node scripts/verify-app-training-videos.mjs` replays the real migration in disposable PostgreSQL. It covers every role and alias, off-today, partner, switched-off, Removed, unknown-role, profile-less and anonymous callers. It checks guessed and unpublished objects, drafts, future and switched-off versions, zero client writes under a permissive legacy storage policy, immutability, the shape checks, and the crew note's audience.
- `node scripts/publish-role-walkthroughs.test.mjs` covers the validator's refusals, the exact transcript JSON contract, and that `--apply` is retired.
- `app/src/lib/appTraining.test.ts` covers the pure rules, the column list, a missing table, and signing failures. It also covers bounded signing (30 s) and bounded optional captions (15 s for headers and body, 1 MB, `no-store`), late answers that never become a blob, and abort on account change.
- `app/src/components/learn/UsingForge.test.tsx` covers the role shelves, the warning placement, no autoplay, `playsInline`, the captions track, chapter seeking, the transcript, retry, offline, Spanish, account and preview switches, late signatures and the absence of writes.
- `app/src/pages/Education.usingForge.test.tsx` checks that the tab stops the learning-time clock while other tabs still count.
- `app/e2e/using-forge.spec.ts` runs browser fixtures at 320 px, 390 px and desktop, in English and Spanish, with real chapter seeking and captions. It includes a 390 px portrait (9:16) recording that must render tall at its own shape. The test videos are synthetic patterns encoded at run time with Playwright's ffmpeg (or `PLAYWRIGHT_FFMPEG`); the test fails, rather than skips, without ffmpeg.
- Not yet verified: physical iPhone Safari, real signed-link playback from production storage, and the production upload limit. Check these at release.
