import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

// Read the repository-root .env, the same file the API uses. Shell variables win.
const envDir = '../..'
const env = loadEnv('development', envDir, '')
const api = `http://${env['HOST'] ?? '127.0.0.1'}:${env['PORT'] ?? '3000'}`
// M0 auth is one development key (docs/ARCHITECTURE.md). The dev server adds it to proxied
// requests, so it never reaches the browser bundle. Real sign-in replaces this in M1.
// WARNING: do not run the dev server with `--host` (or `server.host`) while DEV_API_KEY is set.
// The proxy would then hand an authenticated API to everyone on the network.
const devKey = env['DEV_API_KEY']

export default defineConfig({
  envDir,
  plugins: [vue(), tailwindcss()],
  // Same-origin API calls in development, as in production where one image serves both (D34).
  server: {
    proxy: {
      '/v1': {
        target: api,
        headers: devKey ? { Authorization: `Bearer ${devKey}` } : {},
      },
    },
  },
})
