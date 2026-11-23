import { MAX_VIEW_REQUESTS_IN_FLIGHT } from '@16bit/core'
import { HttpError } from './http.ts'

// D83: up to 4 view-data or aggregate requests in flight per principal per API process; the
// next answers 429 `rate_limited`, which the client queues and retries once its own requests
// finish. A guard for the connection pool against one principal's burst (two tabs, a composer
// preview, overlapping refetches), not a global quota: API pods scale (D34).

export class InFlightLimit {
  private readonly counts = new Map<string, number>()

  readonly max: number

  constructor(max: number = MAX_VIEW_REQUESTS_IN_FLIGHT) {
    this.max = max
  }

  /**
   * Runs `fn` holding one of the principal's slots, or throws 429 when all are taken. The slot
   * is released when `fn` settles, whatever it answers.
   */
  async run<T>(workspaceId: string, principalId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${workspaceId}\u0000${principalId}`
    const held = this.counts.get(key) ?? 0
    if (held >= this.max) {
      throw new HttpError(
        'rate_limited',
        `At most ${String(this.max)} view-data or aggregate requests in flight; retry when one finishes`,
      )
    }
    this.counts.set(key, held + 1)
    try {
      return await fn()
    } finally {
      const left = (this.counts.get(key) ?? 1) - 1
      if (left === 0) this.counts.delete(key)
      else this.counts.set(key, left)
    }
  }

  /** Slots the principal holds now (tests). */
  held(workspaceId: string, principalId: string): number {
    return this.counts.get(`${workspaceId}\u0000${principalId}`) ?? 0
  }
}
