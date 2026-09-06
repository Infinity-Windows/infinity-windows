# 06 — Weak-signal state, sync pill breakdown, offline diagnostics screen

Status: ready-for-agent
Type: task
Size: M

## Horizon does

- `lib/weakSignal.ts`: a Supabase request that TIMES OUT (as opposed to the
  device being offline) marks "weak signal" for 20 s; screens fall back to
  cached data and the status pill says why. A successful request clears it.
- `lib/offlineTelemetry.ts`: a 60-entry in-memory ring of offline events
  (timeout, cache-hit, preflight, flush) mirrored to the console.
- `components/time/SyncStatusPill.tsx`: queue depth by kind (clock, photos,
  GPS, outbox) and last synced time; tap to flush.
- `routes/_app.diagnostics.tsx`: read-only page for support — cached jobs,
  last preflight, last sync, queue depths, the event ring, refreshed every 5 s.
- `hooks/useOfflineQuery.ts`: the single read path — paint the saved copy,
  revalidate, on failure fall back and flag `fromCache` so the screen shows a
  "showing saved copy" line.

## Forge today

Offline is detected; the outbox counts pending writes; there is an
`offline-spec-card` e2e. A phone that is SLOW rather than OFF looks healthy,
and when an installer says "it didn't save" there is nothing to read.

## Build

1. `lib/offline/weakSignal.ts` + tests: timeout wrapper around the Supabase
   fetch (there is already `readBodyCapped`/`fetchWithTimeout`-style code;
   reuse), a 20 s window, a subscribe hook.
2. `lib/offline/telemetry.ts` ring buffer (dependency-free, ~40 lines, tests).
   Log: request timeouts, cache-hit fallbacks, outbox flush outcomes, preflight
   runs (ticket 05), stale-chunk reloads (ticket 07).
3. Status pill in `Layout.tsx`/`nav`: states offline / weak signal / syncing N
   / up to date, with the breakdown by kind on tap. Never moves layout on
   hover (role-maps rule).
4. Route `/diagnostics` behind any signed-in role, plain English, read-only:
   build identity (reuse `BuildIdentityCard`), online state, last sync,
   saved jobs, queue depths, last 60 events. A "Copy report" button that puts
   the whole thing on the clipboard as text for a Slack message.
5. "Showing saved copy" line on the job list, opening sheet and map when data
   came from cache during weak signal.

## Done when

- Throttling to 3g in devtools shows "weak signal" within one failed request
  and the job list still renders from cache with the saved-copy line.
- `/diagnostics` shows the same numbers the pill shows and copies cleanly.
