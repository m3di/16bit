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
