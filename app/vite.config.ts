import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// VITE_BASE is set for GitHub Pages (`/infinity-windows/`). Local/root hosts keep `/`.
const base = process.env.VITE_BASE || '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    react(),
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
