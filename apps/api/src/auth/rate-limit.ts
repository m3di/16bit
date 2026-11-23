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

/** The sign-in window: attempts are counted per 15 minutes. */
export const SIGN_IN_WINDOW_SECONDS = 900
/** Sign-in attempts per email per window, unless `SIGN_IN_LIMIT_PER_EMAIL` says otherwise. */
export const DEFAULT_SIGN_IN_LIMIT_PER_EMAIL = 10
/** Sign-in and invite acceptances per client IP per window, unless `SIGN_IN_LIMIT_PER_IP` says otherwise. */
export const DEFAULT_SIGN_IN_LIMIT_PER_IP = 100
const MAX_SIGN_IN_LIMIT = 1_000_000

export interface SignInLimits {
  loginPerEmail: RateLimitPolicy
  loginPerIp: RateLimitPolicy
}

/**
 * The sign-in limits from the environment (#229): `SIGN_IN_LIMIT_PER_EMAIL` and
 * `SIGN_IN_LIMIT_PER_IP`, attempts per 15-minute window, a whole number from 1 to 1,000,000.
 * Unset or empty keeps the default. Only the end-to-end servers raise them, since one test
 * run signs in and accepts invites from one IP; a deployment keeps the defaults. Throws on
 * anything else, so a typo can't silently remove the limit.
 */
export function signInLimitsFromEnv(env: NodeJS.ProcessEnv): SignInLimits {
  const read = (name: string, fallback: number): RateLimitPolicy => {
    const raw = env[name]
    if (raw === undefined || raw === '')
      return { max: fallback, windowSeconds: SIGN_IN_WINDOW_SECONDS }
    const max = /^\d+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isSafeInteger(max) || max < 1 || max > MAX_SIGN_IN_LIMIT) {
      throw new Error(
        `${name} must be a whole number from 1 to ${String(MAX_SIGN_IN_LIMIT)}, not "${raw}"`,
      )
    }
    return { max, windowSeconds: SIGN_IN_WINDOW_SECONDS }
  }
  return {
    loginPerEmail: read('SIGN_IN_LIMIT_PER_EMAIL', DEFAULT_SIGN_IN_LIMIT_PER_EMAIL),
    loginPerIp: read('SIGN_IN_LIMIT_PER_IP', DEFAULT_SIGN_IN_LIMIT_PER_IP),
  }
}

/**
 * The warning the server logs at start when a production process takes its sign-in limits
 * from the environment, or null. Those variables are for the end-to-end servers; on a
 * deployment they are a mistake worth seeing in the log.
 */
export function signInLimitsWarning(env: NodeJS.ProcessEnv, limits: SignInLimits): string | null {
  if (env['NODE_ENV'] !== 'production') return null
  if (!env['SIGN_IN_LIMIT_PER_IP'] && !env['SIGN_IN_LIMIT_PER_EMAIL']) return null
  return (
    `sign-in limits set from the environment: ${String(limits.loginPerIp.max)} per IP, ` +
    `${String(limits.loginPerEmail.max)} per email, per 15 minutes. Meant for tests only.`
  )
}
