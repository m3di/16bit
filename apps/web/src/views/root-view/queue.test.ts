import { MAX_VIEW_REQUESTS_IN_FLIGHT } from '@16bit/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import { backoff, createRequestQueue } from './queue.ts'

const tooMany = () => new ApiRequestError('rate_limited', 'Too many requests.', 429)

/**
 * The API's guard (D83): one principal gets `limit` requests in flight per process, and the
 * next answers 429. Each request takes `ms`.
 */
function fakeServer(limit = MAX_VIEW_REQUESTS_IN_FLIGHT, ms = 50) {
  let inFlight = 0
  let refused = 0
  let peak = 0
  const call = <T>(value: T) =>
    new Promise<T>((resolve, reject) => {
      if (inFlight >= limit) {
        refused++
        reject(tooMany())
        return
      }
      inFlight++
      peak = Math.max(peak, inFlight)
      setTimeout(() => {
        inFlight--
        resolve(value)
      }, ms)
    })
  return {
    call,
    get refused() {
      return refused
    },
    get peak() {
      return peak
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the view request queue (D83)', () => {
  it('keeps a tab within the per-principal limit, so its own requests never meet a 429', async () => {
    const server = fakeServer()
    const queue = createRequestQueue()
    const all = Promise.all(Array.from({ length: 10 }, (_, i) => queue.run(() => server.call(i))))
    expect(queue.inFlight).toBe(MAX_VIEW_REQUESTS_IN_FLIGHT)
    await vi.advanceTimersByTimeAsync(500)
    await expect(all).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(server.refused).toBe(0)
    expect(server.peak).toBe(MAX_VIEW_REQUESTS_IN_FLIGHT)
  })

  it('renders two tabs of the same person: 429s are retried silently and every request ends well', async () => {
    const server = fakeServer()
    const tabs = [createRequestQueue(), createRequestQueue()]
    const results: Promise<string>[] = []
    for (const [t, queue] of tabs.entries()) {
      for (let i = 0; i < 4; i++)
        results.push(queue.run(() => server.call(`${String(t)}.${String(i)}`)))
    }
    const errors: unknown[] = []
    for (const r of results) r.catch((e: unknown) => errors.push(e))
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(Promise.all(results)).resolves.toHaveLength(8)
    expect(server.refused).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })

  it('retries a 429 as soon as one of its own requests finishes', async () => {
    const queue = createRequestQueue({ limit: 2 })
    let refuse = true
    const slow = queue.run(
      () =>
        new Promise((r) => {
          setTimeout(() => {
            r('slow')
          }, 100)
        }),
    )
    const attempts: number[] = []
    const refused = queue.run(() => {
      attempts.push(Date.now())
      if (refuse) {
        refuse = false
        return Promise.reject(tooMany())
      }
      return Promise.resolve('second')
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toHaveLength(1)
    // Parked until the slow request frees a slot, not on a timer of its own.
    await vi.advanceTimersByTimeAsync(99)
    expect(attempts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(Promise.all([slow, refused])).resolves.toEqual(['slow', 'second'])
    expect(attempts).toHaveLength(2)
  })

  it('waits a little when none of its own requests is in flight (the limit is held elsewhere)', async () => {
    const queue = createRequestQueue()
    let calls = 0
    const result = queue.run(() => {
      calls++
      return calls < 3 ? Promise.reject(tooMany()) : Promise.resolve('ok')
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(backoff(0))
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(backoff(1))
    await expect(result).resolves.toBe('ok')
  })

  it('fails after many 429s in a row, and passes other errors straight on', async () => {
    const queue = createRequestQueue({ maxRetries: 2, retryDelay: () => 10 })
    const limited = queue.run(() => Promise.reject(tooMany()))
    const caught = limited.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(100)
    expect(((await caught) as ApiRequestError).code).toBe('rate_limited')
    const broken = queue.run(() => Promise.reject(new ApiRequestError('internal', 'Boom', 500)))
    await expect(broken).rejects.toMatchObject({ code: 'internal' })
    expect(queue.inFlight).toBe(0)
  })
})
