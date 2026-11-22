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
/** Specs that measure time on the page's main thread (the `budgets` project below). */
const BUDGETS = /-budgets\.spec\.ts$/
/**
 * Specs that must also pass on the production build (issue 233: a template ref that named an
 * import broke the sidebar menus only there, since the dev server compiles templates apart).
 */
const PRODUCTION = /-production\.spec\.ts$/
/** Every spec that runs against the production build instead of the dev server. */
const ON_BUILT = /-(?:budgets|production)\.spec\.ts$/
// The budgets measure the app as people get it: the production build of the web app, served by
// the API from the same port, as in the container image (D34, D61). The maintainer decided this
// for issue 218; the dev server's unminified Vue and module loading are not what users run.
const builtPort = process.env['E2E_BUILT_PORT'] ?? '3001'
const builtUrl = `http://localhost:${builtPort}`
const webRoot = fileURLToPath(new URL('../apps/web/dist', import.meta.url))
/** An app already running elsewhere for the budgets, as `E2E_BASE_URL` is for the rest. */
const externalBuiltUrl = process.env['E2E_BUDGETS_BASE_URL'] ?? externalBaseUrl

// Specs live in tests/*.spec.ts. Each one sets up its own items through the API, so specs can run
// in any order, in parallel, and across shards. The database must be migrated and seeded first
// (`pnpm seed`); the seeded people keep their roles and grants. Specs run signed in as the
// seeded owner; tests/auth.setup.ts signs in every seeded person for the role-matrix specs.
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
    // Signs in once as each seeded person; specs start from the owner's session (#51, #53).
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: OWNER_STATE },
      dependencies: ['setup'],
      testIgnore: ON_BUILT,
    },
    // Functional specs on the production build, served by the API as in the container image.
    {
      name: 'production',
      testMatch: PRODUCTION,
      use: {
        ...devices['Desktop Chrome'],
        storageState: OWNER_STATE,
        baseURL: externalBuiltUrl ?? builtUrl,
      },
      dependencies: ['setup'],
    },
    // D61's timing budgets (issue 178). They measure the page's main thread, so they run after
    // every other spec, one at a time, on an otherwise idle machine: next to other workers the
    // same build shows long tasks it does not have alone. If a spec above fails these are
    // skipped. To run only them: `pnpm e2e --project budgets --no-deps`.
    {
      name: 'budgets',
      testMatch: BUDGETS,
      use: {
        ...devices['Desktop Chrome'],
        storageState: OWNER_STATE,
        // Same host as the dev server, so the signed-in session cookie applies here too.
        baseURL: externalBuiltUrl ?? builtUrl,
      },
      // After the production specs too, which use the same build next to them.
      dependencies: ['chromium', 'production'],
      workers: 1,
    },
  ],
  // Locally, a running `pnpm dev` is reused. In CI both servers are started fresh.
  webServer: externalBaseUrl
    ? undefined
    : [
        {
          name: 'api',
          command: 'pnpm --filter @16bit/api start',
          // The API never holds the owner's URL (#44). .env, loaded above, has it locally.
          env: { MIGRATION_DATABASE_URL: '' },
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
        // For the budgets: the web app built for production, served by a second API process.
        {
          name: 'built',
          command: 'pnpm --filter @16bit/web build && pnpm --filter @16bit/api start',
          env: { MIGRATION_DATABASE_URL: '', PORT: builtPort, WEB_ROOT: webRoot },
          url: `http://${process.env['HOST'] ?? '127.0.0.1'}:${builtPort}/health`,
          reuseExistingServer: !ci,
          timeout: 180_000,
        },
      ],
})
