import type { Attribute } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { attributes } from './fixtures.test-utils.ts'
import { formatValue, fromInput, selectedOption, toInput } from './values.ts'

const [text, select, number] = attributes as [Attribute, Attribute, Attribute]
const date: Attribute = {
  ...text,
  id: 'due',
  type: 'date',
  config: { includeTime: false },
}
const flag: Attribute = { ...text, id: 'flag', type: 'boolean', config: {} }
const link: Attribute = { ...text, id: 'link', type: 'url', config: {} }
const owners: Attribute = { ...text, id: 'owners', type: 'actor', config: { multiple: true } }
const notes: Attribute = { ...text, id: 'notes', type: 'rich_text', config: {} }
const notesDoc = {
  type: 'doc' as const,
  content: [
    { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'one' }] },
    { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'two' }] },
  ],
}

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

  it('shows the M1 types as plain text until their cells land (M1-12)', () => {
    expect(formatValue(link, 'https://16bit.info')).toBe('https://16bit.info')
    expect(formatValue(owners, ['p1', 'p2'])).toBe('p1, p2')
    expect(formatValue(owners, 'p1')).toBe('')
    expect(formatValue(notes, notesDoc)).toBe('one\ntwo')
    expect(formatValue(notes, ['p1'])).toBe('')
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

  it('edits a URL as text and refuses lists and rich text for now (M1-12)', () => {
    expect(fromInput(link, 'https://16bit.info')).toEqual({ ok: true, value: 'https://16bit.info' })
    expect(toInput(link, 'https://16bit.info')).toBe('https://16bit.info')
    const refused = { ok: false, message: 'This field cannot be edited here yet' }
    expect(fromInput(owners, 'p1')).toEqual(refused)
    expect(fromInput(notes, 'hello')).toEqual(refused)
    expect(toInput(owners, ['p1'])).toBe('')
    expect(toInput(notes, notesDoc)).toBe('')
  })

  it('reads a checkbox state', () => {
    expect(fromInput(flag, 'true')).toEqual({ ok: true, value: true })
    expect(toInput(flag, false)).toBe('false')
  })
})
