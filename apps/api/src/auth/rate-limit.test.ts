import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIGN_IN_LIMIT_PER_EMAIL,
  DEFAULT_SIGN_IN_LIMIT_PER_IP,
  RateLimiter,
  signInLimitsFromEnv,
} from './rate-limit.ts'

describe('signInLimitsFromEnv (#229)', () => {
  it('keeps the production defaults when nothing is set, or set empty', () => {
    for (const env of [{}, { SIGN_IN_LIMIT_PER_IP: '', SIGN_IN_LIMIT_PER_EMAIL: '' }]) {
      expect(signInLimitsFromEnv(env)).toEqual({
        loginPerEmail: { max: DEFAULT_SIGN_IN_LIMIT_PER_EMAIL, windowSeconds: 900 },
        loginPerIp: { max: DEFAULT_SIGN_IN_LIMIT_PER_IP, windowSeconds: 900 },
      })
    }
    expect([DEFAULT_SIGN_IN_LIMIT_PER_EMAIL, DEFAULT_SIGN_IN_LIMIT_PER_IP]).toEqual([10, 100])
  })

  it('reads each limit on its own, per 15 minutes', () => {
    expect(signInLimitsFromEnv({ SIGN_IN_LIMIT_PER_IP: '10000' })).toEqual({
      loginPerEmail: { max: 10, windowSeconds: 900 },
      loginPerIp: { max: 10_000, windowSeconds: 900 },
    })
    expect(signInLimitsFromEnv({ SIGN_IN_LIMIT_PER_EMAIL: '1' }).loginPerEmail.max).toBe(1)
    expect(signInLimitsFromEnv({ SIGN_IN_LIMIT_PER_IP: '1000000' }).loginPerIp.max).toBe(1_000_000)
  })

  it('refuses anything but a whole number from 1 to 1,000,000, naming the variable', () => {
    for (const raw of ['0', '-1', '1.5', '1e3', ' 10', 'ten', '1000001', 'Infinity']) {
      expect(() => signInLimitsFromEnv({ SIGN_IN_LIMIT_PER_IP: raw }), raw).toThrow(
        /SIGN_IN_LIMIT_PER_IP must be a whole number/,
      )
      expect(() => signInLimitsFromEnv({ SIGN_IN_LIMIT_PER_EMAIL: raw }), raw).toThrow(
        /SIGN_IN_LIMIT_PER_EMAIL/,
      )
    }
  })

  it('gives a limiter that allows exactly that many attempts per window', () => {
    let now = 0
    const limiter = new RateLimiter(
      signInLimitsFromEnv({ SIGN_IN_LIMIT_PER_IP: '3' }).loginPerIp,
      () => now,
    )
    expect([1, 2, 3, 4].map(() => limiter.hit('ip'))).toEqual([0, 0, 0, 900])
    now += 900_000
    expect(limiter.hit('ip')).toBe(0)
  })
})
