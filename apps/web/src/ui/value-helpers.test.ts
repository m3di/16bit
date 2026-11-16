import { describe, expect, it } from 'vitest'
import { chipsFor } from './chips.ts'
import { rovingIndex } from './roving.ts'
import { displayUrl } from './url.ts'

describe('displayUrl', () => {
  it.each([
    ['https://www.github.com/m3di/16bit/pull/478/', 'github.com/m3di/16bit/pull/478'],
    ['https://example.com', 'example.com'],
    ['http://example.com/a?b=1#c', 'example.com/a?b=1#c'],
    ['mailto:sara@example.com', 'sara@example.com'],
    ['mailto:%E0%A4%A', '%E0%A4%A'],
  ])('shows %s as %s', (value, text) => {
    expect(displayUrl(value)).toMatchObject({ text })
    expect(displayUrl(value).href).not.toBeNull()
  })

  it.each(['javascript:alert(1)', 'not a url', 'ftp://example.com'])('never links %s', (value) => {
    expect(displayUrl(value)).toEqual({ href: null, text: value })
  })
})

describe('chipsFor', () => {
  const options = [
    { id: 'a', label: 'Alpha', color: 'blue' as const },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma', color: 'red' as const },
  ]

  it('keeps the value order and maps colours', () => {
    expect(chipsFor(['c', 'a', 'b'], options).chips).toEqual([
      { id: 'c', label: 'Gamma', color: 'red', missing: false },
      { id: 'a', label: 'Alpha', color: 'blue', missing: false },
      { id: 'b', label: 'Beta', color: null, missing: false },
    ])
  })

  it('marks deleted options instead of hiding them', () => {
    expect(chipsFor(['gone'], options).chips).toEqual([
      { id: 'gone', label: 'Deleted option', color: null, missing: true },
    ])
  })

  it('shows duplicates once', () => {
    expect(chipsFor(['a', 'a'], options).chips).toHaveLength(1)
  })

  it('counts chips past the limit', () => {
    const { chips, overflow } = chipsFor(['a', 'b', 'c'], options, 1)
    expect(chips.map((c) => c.id)).toEqual(['a'])
    expect(overflow).toBe(2)
  })

  it('handles a zero or negative limit', () => {
    expect(chipsFor(['a', 'b'], options, 0)).toEqual({ chips: [], overflow: 2 })
    expect(chipsFor(['a'], options, -1)).toEqual({ chips: [], overflow: 1 })
  })
})

describe('rovingIndex', () => {
  it.each([
    [0, 'ArrowRight', 3, 1],
    [2, 'ArrowRight', 3, 0],
    [0, 'ArrowLeft', 3, 2],
    [1, 'Home', 3, 0],
    [0, 'End', 3, 2],
    [0, 'Tab', 3, null],
    [0, 'ArrowRight', 0, null],
  ])('from %i, %s with %i controls goes to %s', (current, key, count, expected) => {
    expect(rovingIndex(current, key, count)).toBe(expected)
  })
})
