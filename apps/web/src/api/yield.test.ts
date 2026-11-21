import { afterEach, describe, expect, it, vi } from 'vitest'
import { yieldToMain } from './yield.ts'

describe('yieldToMain (issue 218)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses scheduler.yield where the browser has it', async () => {
    const schedulerYield = vi.fn(() => Promise.resolve())
    vi.stubGlobal('scheduler', { yield: schedulerYield })
    await yieldToMain()
    expect(schedulerYield).toHaveBeenCalledOnce()
  })

  it('otherwise resumes in a later task, after work already queued', async () => {
    vi.stubGlobal('scheduler', undefined)
    const order: string[] = []
    const waiting = yieldToMain().then(() => order.push('resumed'))
    void Promise.resolve().then(() => order.push('microtask'))
    await waiting
    expect(order).toEqual(['microtask', 'resumed'])
  })
})
