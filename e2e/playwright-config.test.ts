import { describe, expect, it } from 'vitest'
import config from './playwright.config.ts'

describe('playwright config', () => {
  it('runs specs from tests/ in parallel so they can be sharded', () => {
    expect(config.testDir).toBe('./tests')
    expect(config.fullyParallel).toBe(true)
    expect(config.retries).toBe(0)
  })
})
