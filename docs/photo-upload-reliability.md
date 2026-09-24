# Photo upload recovery

Capture, job Photos and package photos send a file to `install-media`, then upsert an `attachments` row using the outbox entry's stable `client_id`. Both writes must succeed before the saved local file is removed.

The old partial unique index on `attachments(client_id)` could not satisfy PostgREST's `ON CONFLICT (client_id)` statement. Production returned SQLSTATE `42P10` even for an empty batch, so a file could reach storage while its gallery row failed. Browser fixtures alone missed this because they answered every attachment write with success.

`20261018000000_photo_upload_conflict_index.sql` replaces that index with an ordinary unique index. Existing non-null IDs remain unique, and multiple legacy null IDs remain valid. It changes no attachment rows or stored files. We keep the upsert rather than falling back to a plain insert so a lost response and retry cannot create duplicate gallery records.

After updating, `recoverAndDrain` revives the signed-in photographer's failed photo/legacy receipt entries only when their saved error matches this specific index failure and their original blob remains on the device. It retains the ID, storage path and blob. A persisted repair marker prevents repeated automatic retries if a client receives the update before its database does. Other failures can be retried from the new inline upload status or Stuck writes.

Camera startup ends after 20 seconds with a file-picker fallback. The shutter waits for a decoded frame. Image decoding has bounded waits, gallery signing requests have a 15-second deadline, and `install-media` uploads have a two-minute deadline. A timed-out upload is aborted and remains in the existing retry queue; downloads and other large-file transfers retain their existing behavior.

## Unit photos and voice memos (K0.6, 2026-09-23)

A finished unit's before/after photos, walkthrough video and voice memo used to leave the install outbox for a queue of their own (`wops-upload-queue`) that only flushed while the opening sheet was open, inserted `attachments` rows with no `client_id`, retried forever and swallowed every error — and that neither the sync pill nor Stuck writes counted. That is how a phone said "All synced" over a memo that had been queued for a week.

They now ride the main outbox as `photo_upload` entries (`payload.kind` says photo, video or voice memo) under ids the install outbox decides at Submit and writes into its own record, so a crash between "queued the second photo" and "removed the install record" re-queues the same ids instead of new ones (`lib/offline/stableId.ts` derives them for records written before the field existed). The upload handler confirms the memo's row first and reads its id back separately to start the transcript, so a row the SELECT policy will not hand back is still counted as sent; `lib/install/transcriptions.ts` retries any memo that missed that ask.

Items already sitting in the old store on phones in the field are moved on the first start (`lib/install/legacyUploadQueue.ts`): enqueued under the same id, deleted only after the outbox write is durable, and checked against the server by storage path before being filed — the old queue could insert the row and crash before removing the item. Once empty, the old database is deleted. The pill counts what is left in it until then.

The sync pill counts every queue (`lib/offline/pillQueues.ts`) and always opens `/stuck`, which lists what is waiting with its age and state ("Saved on this phone → Sending → Saved in Forge"), not only what gave up. `npm run e2e -- honest-sync.spec.ts` and the offline "Install memo" case in `opening-sheet.spec.ts` pin the whole chain: no signal → relaunch → reconnect → exactly one row per photo.

## Regression checks

- `PGLITE_MODULE=... node scripts/verify-photo-upload.mjs` applies the actual old and new index migrations in a disposable database. It proves the original failure, successful new upserts, safe duplicate retries, migration replay, and legacy null IDs.
- Unit tests cover account-scoped recovery, one-time repair, decoding stalls and request timeouts.
- `npm run e2e -- photos-upload.spec.ts` covers camera readiness, permission denial, stalled startup, library selection, visible server errors, retry, saved-photo recovery and stalled-upload retry. This spec now runs in required CI alongside Capture coverage.
- Production verification checks the deployed commit, repeats an empty attachment batch with zero rows/files, and reads/signs existing gallery images. This verifies the database fix without placing test photos on customer jobs. Browser fixtures are separate from physical iPhone/Android hardware testing.

If photos remain pending, reopen the updated app while connected and use Retry photo uploads. Preserve the app's local data until pending uploads finish; the original image may exist only in that device's queue.
