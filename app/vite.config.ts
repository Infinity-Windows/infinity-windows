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
      registerType: 'autoUpdate',
      // Keep the existing public/manifest.webmanifest + icons.
      manifest: false,
      workbox: {
        // App shell + built assets. Do NOT cache Supabase API — TanStack owns
        // that offline read cache.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,woff2}'],
        // The app-shell JS bundle is >2 MB, above workbox's default precache
        // ceiling. Raise it so the whole shell is precached — offline-first
        // (this outbox feature) depends on the shell loading with no signal.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: `${base}index.html`,
        runtimeCaching: [
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'infinity-images',
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
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
