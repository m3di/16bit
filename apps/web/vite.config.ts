import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

// Read the repository-root .env, the same file the API uses. Shell variables win.
const envDir = '../..'
const env = loadEnv('development', envDir, '')
const api = `http://${env['HOST'] ?? '127.0.0.1'}:${env['PORT'] ?? '3000'}`

export default defineConfig({
  envDir,
  plugins: [vue(), tailwindcss()],
  // Same-origin API calls in development, as in production where one image serves both (D34).
  server: {
    proxy: {
      // Only forwards: people sign in, and the session cookie comes back through this origin.
      // `ws` forwards the feed's WebSocket upgrade (D57). No `changeOrigin`: the API checks a
      // cookie upgrade's `Origin` against `Host`, and both stay this dev server's.
      '/v1': { target: api, ws: true },
    },
  },
})
