import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// VITE_BASE is set for GitHub Pages (`/infinity-windows/`). Local/root hosts keep `/`.
const base = process.env.VITE_BASE || '/'

// Which build this is. CI passes the commit sha (VITE_BUILD_ID); a local build
// gets a timestamp so `npm run dev` and `npm run build` still produce distinct
// ids. Computed ONCE here and used for BOTH the value compiled into the bundle
// and the value written to version.json — if those two could disagree the app
// would believe a newer build existed forever and nag on every check.
const buildId = process.env.VITE_BUILD_ID || `dev-${Date.now()}`
const builtAt = new Date().toISOString()

/**
 * Emit `version.json` next to the bundle so a running app can ask "is there a
 * newer build?" without downloading it.
 *
 * It is deliberately NOT precached: the service worker's globPatterns cover
 * js/css/html/ico/png/svg/webmanifest/woff2 and not json, so a fetch for this
 * goes to the network every time. A precached version file would report the
 * build it shipped with forever, which is precisely the stale-cache trap this
 * is here to escape.
 */
function buildVersionPlugin(): Plugin {
  return {
    name: 'infinity-build-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ buildId, builtAt }),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base,
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILT_AT__: JSON.stringify(builtAt),
  },
  plugins: [
    react(),
    buildVersionPlugin(),
    VitePWA({
      // 'prompt' (not autoUpdate) so a new deploy shows an "update available —
      // Refresh" banner instead of silently reloading mid-task. The register
      // helper (virtual:pwa-register/react) surfaces onNeedRefresh, and src/sw.ts
      // waits for a SKIP_WAITING message before taking over. See PwaBanners.
      registerType: 'prompt',
      // Keep the existing public/manifest.webmanifest + icons.
      manifest: false,
      // Custom SW source (src/sw.ts) so we can add web-push handlers. The SW
      // still precaches the app shell + runtime-caches images exactly as before
      // (that behavior now lives in src/sw.ts). Switched from generateSW to
      // injectManifest ONLY to inject the push/notificationclick handlers.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        // App shell + built assets. Do NOT cache Supabase API — TanStack owns
        // that offline read cache.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,woff2}'],
        // The app-shell JS bundle is >2 MB, above workbox's default precache
        // ceiling. Raise it so the whole shell is precached — offline-first
        // (the outbox feature) depends on the shell loading with no signal.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: {
        // Keep DEV free of a sticky SW — serviceWorkerGuard purges orphans.
        enabled: false,
      },
    }),
  ],
  server: {
    watch: {
      // macOS fsevents misses edits in this folder, leaving the dev server
      // serving stale code. Poll instead so changes always hot-reload.
      usePolling: true,
      interval: 300,
    },
  },
})
