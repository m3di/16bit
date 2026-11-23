import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// A production build of BurndownChart alone, for e2e/perf/burndown-longtasks.ts (issue 259).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
})
