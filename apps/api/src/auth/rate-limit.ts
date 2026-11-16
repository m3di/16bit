// A fixed-window attempt counter held in memory. Enough for one API process; when the API
// runs as several pods (M7) this moves to Postgres or the limit becomes per pod.

export interface RateLimitPolicy {
  /** Attempts allowed per key in one window. */
  max: number
  windowSeconds: number
}

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()
  private readonly policy: RateLimitPolicy
  private readonly now: () => number

  constructor(policy: RateLimitPolicy, now: () => number = Date.now) {
    this.policy = policy
    this.now = now
  }

  /** Counts one attempt. Returns seconds to wait if the key is over its limit, else 0. */
  hit(key: string): number {
    const now = this.now()
    let entry = this.hits.get(key)
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size > 100_000) this.sweep(now)
      entry = { count: 0, resetAt: now + this.policy.windowSeconds * 1000 }
      this.hits.set(key, entry)
    }
    entry.count += 1
    return entry.count > this.policy.max ? Math.ceil((entry.resetAt - now) / 1000) : 0
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key)
  }
}
