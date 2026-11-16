import type { Attribute } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { attributes } from './fixtures.ts'
import { formatValue, fromInput, selectedOption, toInput } from './values.ts'

const [text, select, number] = attributes as [Attribute, Attribute, Attribute]
const date: Attribute = {
  ...text,
  id: 'due',
  type: 'date',
  config: { includeTime: false },
}
const flag: Attribute = { ...text, id: 'flag', type: 'boolean', config: {} }

describe('formatValue', () => {
  it('renders each type for a table cell', () => {
    expect(formatValue(text, 'Hello')).toBe('Hello')
    expect(formatValue(select, 'done')).toBe('Done')
    expect(formatValue(number, 3)).toBe('3')
    expect(formatValue(flag, false)).toBe('No')
    expect(formatValue(date, '2026-11-16')).toBe('Nov 16, 2026')
  })

  it('shows nothing for empty or mistyped values', () => {
    expect(formatValue(text, null)).toBe('')
    expect(formatValue(text, undefined)).toBe('')
    expect(formatValue(number, 'x')).toBe('')
  })

  it('finds the colour of a select option', () => {
    expect(selectedOption(select, 'done')?.color).toBe('green')
    expect(selectedOption(select, 'todo')?.color).toBeUndefined()
    expect(selectedOption(text, 'done')).toBeUndefined()
  })
})

describe('input conversion', () => {
  it('clears a value with an empty input', () => {
    expect(fromInput(text, '')).toEqual({ ok: true, value: null })
    expect(fromInput(number, ' ')).toEqual({ ok: true, value: null })
    expect(fromInput(select, '')).toEqual({ ok: true, value: null })
  })

  it('parses numbers and refuses text', () => {
    expect(fromInput(number, '2.5')).toEqual({ ok: true, value: 2.5 })
    expect(fromInput(number, 'abc')).toEqual({ ok: false, message: 'Enter a number' })
  })

  it('round-trips a date-time through the local input', () => {
    const withTime: Attribute = { ...date, config: { includeTime: true } }
    const iso = '2026-11-16T10:30:00.000Z'
    const parsed = fromInput(withTime, toInput(withTime, iso))
    expect(parsed).toEqual({ ok: true, value: iso })
  })

  it('reads a checkbox state', () => {
    expect(fromInput(flag, 'true')).toEqual({ ok: true, value: true })
    expect(toInput(flag, false)).toBe('false')
  })
})
