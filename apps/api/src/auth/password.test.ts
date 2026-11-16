import { describe, expect, it } from 'vitest'
import { hashPassword, verifyDummy, verifyPassword } from './password.ts'
import { RateLimiter } from './rate-limit.ts'
import { readCookie } from './session.ts'

describe('password hashing', () => {
  it('writes argon2id PHC strings with a fresh salt and verifies them', async () => {
    const a = await hashPassword('correct horse battery')
    const b = await hashPassword('correct horse battery')
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/)
    expect(a).not.toBe(b)
    expect(await verifyPassword('correct horse battery', a)).toBe(true)
    expect(await verifyPassword('correct horse batterY', a)).toBe(false)
  })

  it('treats unreadable or hostile hashes as a wrong password', async () => {
    expect(await verifyPassword('x', 'plain')).toBe(false)
    expect(await verifyPassword('x', '$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaA')).toBe(
      false,
    )
    // Memory far above what we write is refused instead of computed.
    const huge = '$argon2id$v=19$m=4194304,t=2,p=1$c2FsdHNhbHRzYWx0$' + 'A'.repeat(43)
    expect(await verifyPassword('x', huge)).toBe(false)
    // Parameters argon2 rejects (salt shorter than 8 bytes).
    expect(await verifyPassword('x', '$argon2id$v=19$m=19456,t=2,p=1$c2E$' + 'A'.repeat(43))).toBe(
      false,
    )
  })

  it('verifyDummy is always false', async () => {
    expect(await verifyDummy('anything')).toBe(false)
  })
})

describe('RateLimiter', () => {
  it('allows max attempts per window, then reports the seconds left', () => {
    let now = 0
    const limiter = new RateLimiter({ max: 2, windowSeconds: 60 }, () => now)
    expect(limiter.hit('k')).toBe(0)
    expect(limiter.hit('k')).toBe(0)
    now = 30_000
    expect(limiter.hit('k')).toBe(30)
    expect(limiter.hit('other')).toBe(0)
    now = 60_000
    expect(limiter.hit('k')).toBe(0)
  })
})

describe('readCookie', () => {
  it('finds one cookie among several', () => {
    expect(readCookie('a=1; sid=abc; b=2', 'sid')).toBe('abc')
    expect(readCookie('xsid=1', 'sid')).toBeUndefined()
    expect(readCookie(undefined, 'sid')).toBeUndefined()
  })
})
