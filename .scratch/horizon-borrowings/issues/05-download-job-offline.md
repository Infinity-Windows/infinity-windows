# 05 — "Download this job" for offline, WiFi-only by default

Status: resolved
Type: task
Size: M

## Horizon does

`src/lib/offlinePreflight.ts` warms everything a crew needs for their
assigned/today jobs — plansets (large PDFs), task lists, materials, a chat
snapshot — into the same caches the screens read from. Policy: auto/background
prefetch is WiFi-only (skips Save-Data, 2g/3g, or a recent request timeout); a
manual tap passes `force: true` and downloads on cellular.
`components/field/DownloadJobButton.tsx` (one job, anyone) and
`DownloadJobsButton.tsx` (my jobs). Progress callback, "ready" state shown
when the planset is already cached. Last run stored for diagnostics.

## Forge today

`@tanstack/react-query-persist-client` keeps whatever was fetched;
`lib/offline/` is the write outbox; `queryClient.ts` warms locations. PR #535
stopped deleting the persisted cache on launch and kept the spec sheet on the
phone — but only for jobs the installer already opened while they had signal.
There is no way for a foreman to make sure tomorrow's jobs are on every phone.

## Build

1. `lib/offline/preflight.ts` (pure planner + runner): given a job id, the
   list of query keys and storage objects to warm — openings, mark specs,
   planset pages the map needs, the job's photos index, chat snapshot,
   toolbox talk for the day. Use the existing query functions so the cache
   keys match what screens read.
2. Network policy helper (`shouldAutoPrefetch(navigator.connection, weakSignal)`)
   with tests; auto-prefetch WiFi-only, manual tap forces.
3. UI: a "Save for offline" row on the job card and job detail (every role),
   with progress and a "Saved · 3 h ago" state; a "Save my jobs" action on
   My Work / Home / Heartbeat (all three landings, per the role-maps rule).
   Copy in both languages via the i18n catalog.
4. Record last run + job list in the persisted cache meta so ticket 06's
   diagnostics screen can show it.
5. Tests for the planner and the policy; an e2e spec on the fixture harness
   that saves a job, goes offline (`context.setOffline(true)`), and opens the
   opening sheet.

## Done when

- Airplane mode after "Save for offline" opens the job, the map, and an
  opening sheet with its spec, with no spinner that never ends.
- Auto-prefetch does not run on a simulated 3g connection; the manual tap does.

## Comments

2026-09-06 — Built. Less was missing than the ticket assumed: `prefetchJobPack`
(five queries + type brains) and a "Download job for offline use" button already
existed on the job page, and `install/prefetchDrawings.ts` already warms up to
twelve drawings for My Work with a WiFi-only policy. What was missing and now
exists: (1) the map's two reads, `planOutlines` and `elevationViews`, in the
persisted cache and in the pack; (2) the planset PDF bytes kept on the phone
(`lib/offline/plansetBlobCache.ts`, read first by `downloadPlanset`), which is
what makes the flat map draw with no signal; (3) every mark's picture, not just
twelve, when the tap is deliberate; (4) a record of what was saved and when
(`recordSavedJob`), so the button says "Saved offline · 2 h ago" after a reload;
(5) progress ("Saving… 12 of 40"), a partial-save message, and every string in
both languages; (6) `SaveJobsStrip` on all three landings (My Work: the
installer's own jobs; Home and Heartbeat: the active jobs), per the role-maps
rule. The runner (`lib/offline/jobPack.ts`) is pure and never throws: a failed
picture is one entry in `failed`, not a lost job. The manual tap does not
consult the connection type — it is a decision; the background warmer stays
polite. Not built: an automatic nightly pack; My Work's existing warmer covers
the day's units, and the strip is one tap.
