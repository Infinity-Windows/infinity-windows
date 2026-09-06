# 07 — Auto-recover from a stale chunk after a deploy

Status: ready-for-agent
Type: task
Size: S

## Horizon does

`lib/preloadErrorRecovery.ts`: listens for Vite's cancelable
`vite:preloadError` window event (fires when a lazy route/component chunk's
hash changed under an open app). On the first one it reloads once; a
`sessionStorage` timestamp with a 60 s window stops a genuinely broken deploy
from looping. The guard is a pure function with a test.

## Forge today

`lib/pwa/checkForUpdate.ts` and `updateCore.ts` handle the service-worker
update prompt; `unsavedWork.ts` guards reloads. Nothing handles a failed
dynamic import. Forge deploys ~10× a day to GitHub Pages with hashed chunks,
so a phone that opened the app in the morning hits "Failed to fetch dynamically
imported module" on its next lazy route (`App.tsx` has 3 `lazy(` and the map,
studio and fit view are the heavy ones).

## Build

1. `lib/pwa/preloadRecovery.ts`: `shouldReloadOnPreloadError(lastAt, now)`
   pure + tests; an installer that registers the `vite:preloadError` listener
   in `main.tsx`, respects `unsavedWork` (do not reload over an unsaved
   opening sheet — show the existing update toast instead), logs to ticket 06's
   telemetry if present.
2. Toast copy in both languages: "The app updated. Reloading…".

## Done when

- Unit tests cover first error → reload, second within 60 s → no reload,
  unsaved work → toast not reload.
- Manual: deploy, keep an old tab open, navigate to the map → one reload, no
  white screen.
