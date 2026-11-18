import {
  ATTRIBUTE_TYPE_NAMES,
  PALETTE_COLORS,
  selectConfigSchema,
  type SelectOption,
} from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { rovingIndex } from './roving.ts'
import {
  ATTRIBUTE_TYPE_INFO,
  ATTRIBUTE_TYPE_ORDER,
  confirmTextMatches,
  itemCount,
  MAX_OPTIONS,
  menuOpenFocus,
  moveOption,
  newOptionId,
  nextOptionColor,
  optionErrors,
  usageText,
} from './settings.ts'

describe('rovingIndex, vertical (menus)', () => {
  it.each([
    [0, 'ArrowDown', 3, 1],
    [2, 'ArrowDown', 3, 0],
    [0, 'ArrowUp', 3, 2],
    [1, 'Home', 3, 0],
    [0, 'End', 3, 2],
    // Left and right do nothing in a vertical menu.
    [1, 'ArrowRight', 3, null],
    [1, 'ArrowLeft', 3, null],
  ])('from %i, %s with %i items goes to %s', (current, key, count, expected) => {
    expect(rovingIndex(current, key, count, 'vertical')).toBe(expected)
  })

  it('horizontal ignores up and down', () => {
    expect(rovingIndex(0, 'ArrowDown', 3)).toBeNull()
  })
})

describe('menuOpenFocus', () => {
  it.each([
    ['ArrowDown', 'first'],
    // Enter and Space are the button's click.
    ['Enter', null],
    [' ', null],
    ['ArrowUp', 'last'],
    ['Escape', null],
    ['a', null],
  ])('%j opens on the %s item', (key, expected) => {
    expect(menuOpenFocus(key)).toBe(expected)
  })
})

describe('confirmTextMatches', () => {
  it.each([
    ['Engineering', 'Engineering', true],
    ['  Engineering ', 'Engineering', true],
    ['engineering', 'Engineering', false],
    ['Engineer', 'Engineering', false],
    ['', 'Engineering', false],
    // An empty name never confirms, so a missing name cannot unlock a delete.
    ['', '', false],
    ['  ', ' ', false],
  ])('%j against %j is %s', (typed, expected, result) => {
    expect(confirmTextMatches(typed, expected)).toBe(result)
  })
})

describe('attribute type info', () => {
  it('names and orders every core type exactly once', () => {
    expect(Object.keys(ATTRIBUTE_TYPE_INFO).sort()).toEqual([...ATTRIBUTE_TYPE_NAMES].sort())
    expect([...ATTRIBUTE_TYPE_ORDER].sort()).toEqual([...ATTRIBUTE_TYPE_NAMES].sort())
  })
})

const opt = (id: string, label: string): SelectOption => ({ id, label })

describe('options', () => {
  it('newOptionId never reuses an ID', () => {
    const values = [0.5, 0.5, 0.25]
    const random = () => values.shift() ?? 0.75
    const first = newOptionId([], () => 0.5)
    const id = newOptionId([opt(first, 'Done')], random)
    expect(id).not.toBe(first)
    expect(id).toMatch(/^opt_[0-9a-z]{8}$/)
  })

  it('nextOptionColor walks the palette and wraps', () => {
    expect(nextOptionColor([])).toBe(PALETTE_COLORS[0])
    const sixteen = PALETTE_COLORS.map((c) => opt(c, c))
    expect(nextOptionColor(sixteen)).toBe(PALETTE_COLORS[0])
    expect(nextOptionColor(sixteen.slice(0, 3))).toBe(PALETTE_COLORS[3])
  })

  it('moveOption moves by one and leaves the ends alone', () => {
    const list = ['a', 'b', 'c']
    expect(moveOption(list, 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveOption(list, 1, 1)).toEqual(['a', 'c', 'b'])
    expect(moveOption(list, 0, -1)).toEqual(list)
    expect(moveOption(list, 2, 1)).toEqual(list)
    expect(moveOption(list, 5, 1)).toEqual(list)
    expect(list).toEqual(['a', 'b', 'c'])
  })

  it('optionErrors flags blank names and clashes, not the first of a pair', () => {
    expect(
      optionErrors([opt('1', 'Done'), opt('2', ' done '), opt('3', '  '), opt('4', 'Doing')]),
    ).toEqual({ '2': 'Another option has this name.', '3': 'Name the option.' })
    expect(optionErrors([])).toEqual({})
  })

  it('MAX_OPTIONS is the limit core enforces', () => {
    const list = (n: number) =>
      Array.from({ length: n }, (_, i) => opt(`o${String(i)}`, `O${String(i)}`))
    expect(selectConfigSchema.safeParse({ options: list(MAX_OPTIONS) }).success).toBe(true)
    expect(selectConfigSchema.safeParse({ options: list(MAX_OPTIONS + 1) }).success).toBe(false)
  })

  it('itemCount formats like the confirm', () => {
    expect(itemCount(0)).toBe('0 items')
    expect(itemCount(1)).toBe('1 item')
    expect(itemCount(1280)).toBe('1,280 items')
  })

  it('usageText counts items in words', () => {
    expect(usageText(1)).toBe('1 item uses this option')
    expect(usageText(1280)).toBe('1,280 items use this option')
  })
})
