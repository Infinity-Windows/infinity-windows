import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
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
        navigateFallback: '/index.html',
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
