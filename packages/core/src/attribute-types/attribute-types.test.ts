import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTE_TYPE_NAMES,
  attributeTypes,
  booleanType,
  dateType,
  numberType,
  selectType,
  textType,
  TEXT_MAX_LENGTH,
} from './index.ts'

const accepts = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success

describe('registry', () => {
  it('has one implementation per type name, registered under its own name', () => {
    expect(Object.keys(attributeTypes).sort()).toEqual([...ATTRIBUTE_TYPE_NAMES].sort())
    for (const [name, type] of Object.entries(attributeTypes)) expect(type.name).toBe(name)
  })

  it('gives every type the empty operators and base summaries', () => {
    for (const type of Object.values(attributeTypes)) {
      expect(type.filterOperators).toEqual(expect.arrayContaining(['is_empty', 'is_not_empty']))
      expect(type.summaries).toEqual(expect.arrayContaining(['count', 'count_empty']))
    }
  })
})

describe('text', () => {
  const config = textType.configSchema.parse({})

  it('accepts strings up to the limit and rejects other shapes', () => {
    const schema = textType.valueSchema(config)
    expect(accepts(schema, 'hello')).toBe(true)
    expect(accepts(schema, 'x'.repeat(TEXT_MAX_LENGTH))).toBe(true)
    expect(accepts(schema, 'x'.repeat(TEXT_MAX_LENGTH + 1))).toBe(false)
    expect(accepts(schema, 42)).toBe(false)
    expect(accepts(schema, ['a'])).toBe(false)
  })

  it('honours maxLength from config', () => {
    const schema = textType.valueSchema({ maxLength: 3 })
    expect(accepts(schema, 'abc')).toBe(true)
    expect(accepts(schema, 'abcd')).toBe(false)
  })

  it('rejects invalid config', () => {
    expect(accepts(textType.configSchema, { maxLength: 0 })).toBe(false)
    expect(accepts(textType.configSchema, { unknown: true })).toBe(false)
  })

  it('treats the empty string as empty and sorts case-insensitively', () => {
    expect(textType.isEmpty('', config)).toBe(true)
    expect(textType.isEmpty(' ', config)).toBe(false)
    expect(textType.sortKey('Banana', config) > textType.sortKey('apple', config)).toBe(true)
    expect(textType.project('Hi', config)).toEqual(['Hi'])
  })
})

describe('number', () => {
  const plain = numberType.configSchema.parse({})

  it('defaults to plain format', () => {
    expect(plain.format).toBe('plain')
  })

  it('accepts finite numbers and rejects everything else', () => {
    const schema = numberType.valueSchema(plain)
    expect(accepts(schema, 0)).toBe(true)
    expect(accepts(schema, -1.5)).toBe(true)
    expect(accepts(schema, '1')).toBe(false)
    expect(accepts(schema, Number.NaN)).toBe(false)
    expect(accepts(schema, Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('enforces min and max', () => {
    const schema = numberType.valueSchema(numberType.configSchema.parse({ min: 0, max: 10 }))
    expect(accepts(schema, 0)).toBe(true)
    expect(accepts(schema, 10)).toBe(true)
    expect(accepts(schema, -0.1)).toBe(false)
    expect(accepts(schema, 10.1)).toBe(false)
  })

  it('rejects contradictory config', () => {
    expect(accepts(numberType.configSchema, { min: 5, max: 1 })).toBe(false)
    expect(accepts(numberType.configSchema, { format: 'currency' })).toBe(false)
    expect(accepts(numberType.configSchema, { format: 'currency', currency: 'eur' })).toBe(false)
    expect(accepts(numberType.configSchema, { format: 'currency', currency: 'EUR' })).toBe(true)
  })

  it('renders formats for agents', () => {
    const percent = numberType.configSchema.parse({ format: 'percent', decimals: 1 })
    const money = numberType.configSchema.parse({
      format: 'currency',
      currency: 'EUR',
      decimals: 2,
    })
    expect(numberType.render(12.345, percent)).toBe('12.3%')
    expect(numberType.render(5, money)).toBe('5.00 EUR')
    expect(numberType.render(null, plain)).toBe('')
  })

  it('projects to the num column and sorts numerically', () => {
    expect(numberType.indexProjection).toBe('num')
    expect(numberType.project(3, plain)).toEqual([3])
    expect(numberType.sortKey(10, plain) > numberType.sortKey(9, plain)).toBe(true)
  })

  it('emits JSON Schema with bounds', () => {
    expect(numberType.jsonSchema(numberType.configSchema.parse({ min: 1 }))).toEqual({
      type: 'number',
      minimum: 1,
    })
  })
})

describe('boolean', () => {
  const config = booleanType.configSchema.parse({})

  it('accepts only true and false', () => {
    const schema = booleanType.valueSchema(config)
    expect(accepts(schema, true)).toBe(true)
    expect(accepts(schema, false)).toBe(true)
    expect(accepts(schema, 'true')).toBe(false)
    expect(accepts(schema, 0)).toBe(false)
  })

  it('never counts false as empty', () => {
    expect(booleanType.isEmpty(false, config)).toBe(false)
  })

  it('renders and groups', () => {
    expect(booleanType.render(true, config)).toBe('yes')
    expect(booleanType.render(false, config)).toBe('no')
    expect(booleanType.groupKey(false, config)).toBe('false')
  })

  it('projects to 0 or 1 in the number column so it can be filtered (D20)', () => {
    expect(booleanType.indexProjection).toBe('num')
    expect(booleanType.project(true, config)).toEqual([1])
    expect(booleanType.project(false, config)).toEqual([0])
  })
})

describe('date', () => {
  const dateOnly = dateType.configSchema.parse({})
  const withTime = dateType.configSchema.parse({ includeTime: true })

  it('accepts only calendar dates when time is off', () => {
    const schema = dateType.valueSchema(dateOnly)
    expect(accepts(schema, '2026-11-16')).toBe(true)
    expect(accepts(schema, '2026-02-30')).toBe(false)
    expect(accepts(schema, '2026-11-16T10:00:00Z')).toBe(false)
    expect(accepts(schema, '16/11/2026')).toBe(false)
    expect(accepts(schema, 20261116)).toBe(false)
  })

  it('requires a zone on date-times when time is on', () => {
    const schema = dateType.valueSchema(withTime)
    expect(accepts(schema, '2026-11-16T10:00:00Z')).toBe(true)
    expect(accepts(schema, '2026-11-16T10:00:00+03:30')).toBe(true)
    expect(accepts(schema, '2026-11-16T10:00:00')).toBe(false)
    expect(accepts(schema, '2026-11-16')).toBe(false)
  })

  it('projects to UTC and sorts by instant, not by string', () => {
    expect(dateType.project('2026-11-16T10:00:00+02:00', withTime)).toEqual([
      '2026-11-16T08:00:00.000Z',
    ])
    expect(dateType.project('2026-11-16', dateOnly)).toEqual(['2026-11-16T00:00:00.000Z'])
    // Later as a string, earlier as an instant.
    expect(
      dateType.sortKey('2026-11-16T10:00:00+05:00', withTime) <
        dateType.sortKey('2026-11-16T09:00:00Z', withTime),
    ).toBe(true)
  })

  it('groups by UTC day', () => {
    expect(dateType.groupKey('2026-11-16T23:30:00-02:00', withTime)).toBe('2026-11-17')
  })

  it('emits a JSON Schema format matching the config', () => {
    expect(dateType.jsonSchema(dateOnly)).toEqual({ type: 'string', format: 'date' })
    expect(dateType.jsonSchema(withTime)).toEqual({ type: 'string', format: 'date-time' })
  })
})

describe('select', () => {
  const config = selectType.configSchema.parse({
    options: [
      { id: 'todo', label: 'To do' },
      { id: 'done', label: 'Done', color: 'green' },
    ],
  })

  it('accepts option IDs only, not labels', () => {
    const schema = selectType.valueSchema(config)
    expect(accepts(schema, 'todo')).toBe(true)
    expect(accepts(schema, 'To do')).toBe(false)
    expect(accepts(schema, 'nope')).toBe(false)
    expect(accepts(schema, 1)).toBe(false)
  })

  it('rejects everything when there are no options', () => {
    expect(accepts(selectType.valueSchema({ options: [] }), 'todo')).toBe(false)
  })

  it('rejects duplicate option IDs', () => {
    const duplicated = {
      options: [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'B' },
      ],
    }
    expect(accepts(selectType.configSchema, duplicated)).toBe(false)
  })

  it('sorts by option order and renders the label', () => {
    expect(selectType.sortKey('todo', config)).toBe(0)
    expect(selectType.sortKey('done', config)).toBe(1)
    expect(selectType.render('done', config)).toBe('Done')
    expect(selectType.render(null, config)).toBe('')
  })

  it('sorts a value whose option was deleted after every real option', () => {
    const orphan = selectType.sortKey('deleted', config)
    expect(orphan).toBe(config.options.length)
    expect(orphan > selectType.sortKey('done', config)).toBe(true)
  })

  it('accepts palette colour names and rejects hex', () => {
    const withColor = (color: string) => ({ options: [{ id: 'a', label: 'A', color }] })
    expect(accepts(selectType.configSchema, withColor('violet'))).toBe(true)
    expect(accepts(selectType.configSchema, withColor('#ff0000'))).toBe(false)
    expect(accepts(selectType.configSchema, withColor('purple'))).toBe(false)
  })

  it('emits an enum for agents', () => {
    expect(selectType.jsonSchema(config)).toMatchObject({ type: 'string', enum: ['todo', 'done'] })
  })
})
