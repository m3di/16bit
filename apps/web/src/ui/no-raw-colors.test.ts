import { describe, expect, it } from 'vitest'

// Components use tokens, never raw colour values. tokens.css is the only place colours live.
const sources = import.meta.glob<string>(['../**/*.vue', '../**/*.ts', '!../**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

const RAW_COLOR = /#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?\b|\b(?:rgba?|hsla?|oklch|oklab)\(/i

describe('source files', () => {
  it('were found', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5)
  })

  it.each(Object.entries(sources))('%s has no raw colour values', (_path, text) => {
    expect(text.match(RAW_COLOR)?.[0]).toBeUndefined()
  })
})
