import { describe, expect, it } from 'vitest'
import config from './playwright.config.ts'

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
    expect(budgets).toMatchObject({ dependencies: ['chromium'], workers: 1 })
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
    const servers = Array.isArray(config.webServer) ? config.webServer : []
    const built = servers.find((server) => server.name === 'built')
    expect(built?.command).toMatch(
      /^pnpm --filter @16bit\/web build && pnpm --filter @16bit\/api start$/,
    )
    expect(built?.env).toMatchObject({ MIGRATION_DATABASE_URL: '' })
    expect(built?.env?.['WEB_ROOT']).toMatch(/apps\/web\/dist$/)
    const port = built?.env?.['PORT'] ?? ''
    expect(built?.url).toMatch(new RegExp(`:${port}/health$`))
    if (!process.env['E2E_BASE_URL'] && !process.env['E2E_BUDGETS_BASE_URL'])
      expect(budgets?.use?.baseURL).toBe(`http://localhost:${port}`)
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
