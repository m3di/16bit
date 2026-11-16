import { describe, expect, it } from 'vitest'
import { safeNext } from './next.ts'

describe('safeNext', () => {
  it('keeps a path in this app, with its query and hash', () => {
    expect(safeNext('/w/w1/hubs/h1?item=i1')).toBe('/w/w1/hubs/h1?item=i1')
    expect(safeNext('/invite/abc#x')).toBe('/invite/abc#x')
    expect(safeNext(['/a', '/b'])).toBe('/a')
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['absolute URL', 'https://evil.example/'],
    ['protocol-relative', '//evil.example/'],
    ['backslash', '/\\evil.example'],
    ['tab', '/\t/evil.example'],
    ['dot segment to //', '/.//evil.example'],
    ['javascript', 'javascript:alert(1)'],
    ['relative', 'w/w1'],
    ['the sign-in page', '/sign-in?next=/'],
  ])('falls back to / for %s', (_, value) => {
    expect(safeNext(value)).toBe('/')
  })
})
