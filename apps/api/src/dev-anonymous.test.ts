import { describe, expect, it } from 'vitest'
import { checkDevAnonymous } from './dev-anonymous.ts'

const on = { DEV_ANONYMOUS_AS_OWNER: 'true' }

describe('checkDevAnonymous', () => {
  it('is off unless the flag is exactly "true"', () => {
    expect(checkDevAnonymous({}, '0.0.0.0')).toEqual({ enabled: false })
    expect(checkDevAnonymous({ DEV_ANONYMOUS_AS_OWNER: '1' }, '0.0.0.0')).toEqual({
      enabled: false,
    })
  })

  it.each(['127.0.0.1', '::1', 'localhost'])('allows loopback host %s, with a warning', (host) => {
    const result = checkDevAnonymous(on, host)
    expect(result).toMatchObject({ enabled: true })
    expect(result).toHaveProperty('warning', expect.stringContaining('DEV_ANONYMOUS_AS_OWNER'))
    expect(result).not.toHaveProperty('error')
  })

  it.each(['0.0.0.0', '::', '192.168.1.10', 'example.com'])(
    'refuses non-loopback host %s',
    (host) => {
      const result = checkDevAnonymous(on, host)
      expect(result).toHaveProperty('error', expect.stringContaining(`HOST=${host}`))
    },
  )

  it('allows a non-loopback host only with DEV_ANONYMOUS_ALLOW_NONLOCAL=1', () => {
    expect(
      checkDevAnonymous({ ...on, DEV_ANONYMOUS_ALLOW_NONLOCAL: '1' }, '0.0.0.0'),
    ).toHaveProperty('warning')
    expect(
      checkDevAnonymous({ ...on, DEV_ANONYMOUS_ALLOW_NONLOCAL: 'true' }, '0.0.0.0'),
    ).toHaveProperty('error')
  })
})
