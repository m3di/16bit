import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { OWNER_STATE } from './tests/support/auth-state.ts'

// Read the repository-root .env like the API and web app do. Shell variables win, so CI sets
// everything in the job's env and has no .env.
const rootEnv = fileURLToPath(new URL('../.env', import.meta.url))
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const ci = !!process.env['CI']
const apiUrl = `http://${process.env['HOST'] ?? '127.0.0.1'}:${process.env['PORT'] ?? '3000'}`
// Point the suite at an app that is already running somewhere else, and nothing is started here.
const externalBaseUrl = process.env['E2E_BASE_URL']
// Port of the web dev server started for the suite, when 5173 is taken by another checkout.
const webPort = process.env['E2E_WEB_PORT'] ?? '5173'
const webUrl = `http://localhost:${webPort}`

// Specs live in tests/*.spec.ts. Each one sets up its own items through the API, so specs can run
// in any order, in parallel, and across shards. The database must be migrated and seeded first
// (`pnpm seed`); the seeded workspaces and hubs are read but never changed. Specs run signed in
// as the seeded owner (tests/auth.setup.ts).
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: ci,
  // A flaky test is a bug: fix it or open an issue. Never retry it into passing.
  retries: 0,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: externalBaseUrl ?? webUrl,
    trace: 'retain-on-failure',
  },
  projects: [
    // Signs in once as the seeded owner; every spec starts from that session (#51).
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: OWNER_STATE },
      dependencies: ['setup'],
    },
  ],
  // Locally, a running `pnpm dev` is reused. In CI both servers are started fresh.
  webServer: externalBaseUrl
    ? undefined
    : [
        {
          name: 'api',
          command: 'pnpm --filter @16bit/api start',
          // /health also checks the database, so the suite starts only once Postgres answers.
          url: `${apiUrl}/health`,
          reuseExistingServer: !ci,
          timeout: 60_000,
        },
        {
          name: 'web',
          command: `pnpm --filter @16bit/web dev --port ${webPort} --strictPort`,
          url: webUrl,
          reuseExistingServer: !ci,
          timeout: 60_000,
        },
      ],
})
