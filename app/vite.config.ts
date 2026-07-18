import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // macOS fsevents misses edits in this folder, leaving the dev server
      // serving stale code. Poll instead so changes always hot-reload.
      usePolling: true,
      interval: 300,
    },
  },
})
