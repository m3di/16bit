import { describe, expect, it } from 'vitest'

// Components use tokens, never raw colour values. tokens.css is the only place colours live.
const sources = import.meta.glob<string>(['../**/*.vue', '../**/*.ts', '!../**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

// A hex colour follows a colon, a space, an opening bracket, or a quote, as in `color: #fff` or
// `'#fff'`. Fragment links such as `href="#add"` are not colours.
const RAW_COLOR =
  /(?<!href=["'])(?<=[:\s(,'"`])#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?\b|\b(?:rgba?|hsla?|oklch|oklab)\(/i

describe('source files', () => {
  it('were found', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5)
  })

  it.each([
    ['color: #fff', true],
    ["background: '#3B4CCA'", true],
    ['fill="#abcdef80"', true],
    ['rgb(0 0 0)', true],
    ['href="#add"', false],
    ['<a href="#bad">', false],
  ])('the pattern reads %s as a colour: %s', (text, isColor) => {
    expect(RAW_COLOR.test(text)).toBe(isColor)
  })

  it.each(Object.entries(sources))('%s has no raw colour values', (_path, text) => {
    expect(text.match(RAW_COLOR)?.[0]).toBeUndefined()
  })
})
