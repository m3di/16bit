import { describe, expect, it } from 'vitest'
import config, { builtServer, E2E_SIGN_IN_LIMIT_PER_IP, runsOnBuilt } from './playwright.config.ts'

describe('playwright config', () => {
  it('runs specs from tests/ in parallel so they can be sharded', () => {
    expect(config.testDir).toBe('./tests')
    expect(config.fullyParallel).toBe(true)
    expect(config.retries).toBe(0)
  })

  it('runs the timing budgets alone, after every other spec (issue 178)', () => {
    const projects = config.projects ?? []
    const budgets = projects.find((p) => p.name === 'budgets')
    const chromium = projects.find((p) => p.name === 'chromium')
    // Never next to another spec, the production specs included.
    expect(budgets).toMatchObject({ dependencies: ['chromium', 'production'], workers: 1 })
    const match = budgets?.testMatch as RegExp
    const ignore = chromium?.testIgnore as RegExp
    expect(match.test('large-folder-budgets.spec.ts')).toBe(true)
    expect(ignore.test('large-folder-budgets.spec.ts')).toBe(true)
    expect(ignore.test('large-folder.spec.ts')).toBe(false)
  })

  it('runs the production specs on the production build, and not on the dev server', () => {
    const projects = config.projects ?? []
    const production = projects.find((p) => p.name === 'production')
    const budgets = projects.find((p) => p.name === 'budgets')
    const chromium = projects.find((p) => p.name === 'chromium')
    const match = production?.testMatch as RegExp
    expect(match.test('hub-sidebar-production.spec.ts')).toBe(true)
    expect(match.test('hub-sidebar.spec.ts')).toBe(false)
    expect((chromium?.testIgnore as RegExp).test('hub-sidebar-production.spec.ts')).toBe(true)
    expect(production?.use?.baseURL).toBe(budgets?.use?.baseURL)
  })

  it('measures the budgets on the production build, served by the API (issue 218)', () => {
    const budgets = (config.projects ?? []).find((p) => p.name === 'budgets')
    const built = builtServer
    expect(built.command).toMatch(
      /^pnpm --filter @16bit\/web build && pnpm --filter @16bit\/api start$/,
    )
    expect(built.env).toMatchObject({ MIGRATION_DATABASE_URL: '' })
    expect(built.env.WEB_ROOT).toMatch(/apps\/web\/dist$/)
    const port = built.env.PORT
    expect(built.url).toMatch(new RegExp(`:${port}/health$`))
    if (!process.env['E2E_BASE_URL'] && !process.env['E2E_BUDGETS_BASE_URL'])
      expect(budgets?.use?.baseURL).toBe(`http://localhost:${port}`)
  })

  it('builds and starts the production server only for runs that use it (issue 228)', () => {
    const cli = ['node', 'playwright', 'test']
    // Every project runs, so both built-app projects do.
    expect(runsOnBuilt(cli)).toBe(true)
    expect(runsOnBuilt([...cli, '--project', 'budgets', '--no-deps'])).toBe(true)
    expect(runsOnBuilt([...cli, '--project=production'])).toBe(true)
    expect(runsOnBuilt([...cli, '--project', 'chromium', 'Production'])).toBe(true)
    expect(runsOnBuilt([...cli, '--project', 'chromium', '--project', 'budgets'])).toBe(true)
    expect(runsOnBuilt([...cli, '--project', 'bud*'])).toBe(true)
    // Neither: chromium's only dependency is setup, so nothing pulls the built projects in.
    expect(runsOnBuilt([...cli, '--project', 'chromium'])).toBe(false)
    expect(runsOnBuilt([...cli, '--project=chromium', 'tests/hub-items.spec.ts'])).toBe(false)
    expect(runsOnBuilt([...cli, '--project', 'setup', 'chromium', '-x'])).toBe(false)
    expect(runsOnBuilt([...cli, '--project', 'chrom*'])).toBe(false)
    // Each name in BUILT_PROJECTS is a real project, so the check cannot drift from the list.
    const names = (config.projects ?? []).map((p) => p.name)
    for (const name of ['budgets', 'production']) expect(names).toContain(name)
    // And this run's config (vitest's argv has no --project) holds exactly that server.
    const servers = Array.isArray(config.webServer) ? config.webServer : []
    const external = process.env['E2E_BASE_URL'] ?? process.env['E2E_BUDGETS_BASE_URL']
    expect(servers.includes(builtServer)).toBe(!external && runsOnBuilt(process.argv))
  })

  it('never measures whatever already listens on the built port (issue 228)', () => {
    // Not even locally: an older build there would give misleading budget timings. A run
    // rebuilds, and Playwright refuses to start while the port is taken.
    expect(builtServer.reuseExistingServer).toBe(false)
    expect(builtServer.command).toMatch(/^pnpm --filter @16bit\/web build && /)
  })

  it('raises the sign-in limit per IP on the API servers it starts, and nothing else (issue 229)', () => {
    const servers = Array.isArray(config.webServer) ? config.webServer : []
    expect(Number(E2E_SIGN_IN_LIMIT_PER_IP)).toBeGreaterThan(100)
    const api = servers.find((server) => server.name === 'api')
    for (const env of [api?.env ?? {}, builtServer.env]) {
      expect(env['SIGN_IN_LIMIT_PER_IP']).toBe(E2E_SIGN_IN_LIMIT_PER_IP)
      expect(env).not.toHaveProperty('SIGN_IN_LIMIT_PER_EMAIL')
    }
    expect(servers.find((server) => server.name === 'web')?.env ?? {}).not.toHaveProperty(
      'SIGN_IN_LIMIT_PER_IP',
    )
  })

  it('starts the API without the owner URL, which .env may set (#44)', () => {
    const servers = Array.isArray(config.webServer) ? config.webServer : []
    const api = servers.find((server) => server.name === 'api')
    expect(api).toBeDefined()
    // Playwright gives the command process.env with this on top (checked in the 1.65.1 runner;
    // recheck on upgrade, since this test builds the merged env itself).
    const env = { ...process.env, MIGRATION_DATABASE_URL: 'postgres://owner@x/db', ...api?.env }
    expect(env['MIGRATION_DATABASE_URL']).toBe('')
  })
})
