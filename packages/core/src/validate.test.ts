import { describe, expect, it } from 'vitest'
import {
  attributeSchema,
  itemSchema,
  validateItemValues,
  type Attribute,
  type FolderAttributeDefinition,
} from './index.ts'

const base = { workspaceId: 'w1', hubId: 'h1', indexed: false }

const attr = (a: Record<string, unknown>): Attribute => attributeSchema.parse({ ...base, ...a })

const title = attr({ id: 'title', name: 'Title', type: 'text', config: {} })
const points = attr({ id: 'points', name: 'Points', type: 'number', config: { min: 0 } })
const blocked = attr({ id: 'blocked', name: 'Blocked', type: 'boolean', config: {} })
const due = attr({ id: 'due', name: 'Due', type: 'date', config: {} })
const stage = attr({
  id: 'stage',
  name: 'Stage',
  type: 'select',
  config: { options: [{ id: 'todo', label: 'To do' }] },
})

const fields: FolderAttributeDefinition[] = [
  { attribute: title, required: true },
  { attribute: points, required: false },
  { attribute: blocked, required: false },
  { attribute: due, required: false },
  { attribute: stage, required: false },
]

describe('validateItemValues', () => {
  it('accepts a full set of valid values', () => {
    const values = { title: 'Ship M0', points: 3, blocked: false, due: '2026-11-30', stage: 'todo' }
    expect(validateItemValues(fields, values)).toEqual({ ok: true, values })
  })

  it('accepts null to clear an optional value', () => {
    expect(validateItemValues(fields, { title: 'x', points: null })).toEqual({
      ok: true,
      values: { title: 'x', points: null },
    })
  })

  it('reports a missing required value on create', () => {
    expect(validateItemValues(fields, { points: 1 })).toEqual({
      ok: false,
      errors: [{ attributeId: 'title', code: 'required', message: 'A value is required' }],
    })
  })

  it('ignores missing required values on a partial patch', () => {
    expect(validateItemValues(fields, { points: 1 }, { partial: true })).toEqual({
      ok: true,
      values: { points: 1 },
    })
  })

  it('refuses to clear a required value, with null or an empty string, even on a patch', () => {
    for (const value of [null, '']) {
      const result = validateItemValues(fields, { title: value }, { partial: true })
      expect(result).toEqual({
        ok: false,
        errors: [{ attributeId: 'title', code: 'required', message: 'A value is required' }],
      })
    }
  })

  it('normalises an empty optional text to null', () => {
    const optionalText: FolderAttributeDefinition[] = [{ attribute: title, required: false }]
    expect(validateItemValues(optionalText, { title: '' })).toEqual({
      ok: true,
      values: { title: null },
    })
  })

  it('rejects attributes that are not on the folder', () => {
    const result = validateItemValues(fields, { title: 'x', owner: 'me' })
    expect(result).toMatchObject({
      ok: false,
      errors: [{ attributeId: 'owner', code: 'unknown_attribute' }],
    })
  })

  it('is not fooled by prototype keys', () => {
    const values = JSON.parse('{"title":"x","__proto__":"y","constructor":1}') as Record<
      string,
      unknown
    >
    const result = validateItemValues(fields, values)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.map((e) => e.attributeId).sort()).toEqual(['__proto__', 'constructor'])
    }
  })

  it('collects every invalid value in one pass', () => {
    const result = validateItemValues(fields, {
      title: 7,
      points: -1,
      blocked: 'no',
      due: 'tomorrow',
      stage: 'done',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.map((e) => [e.attributeId, e.code])).toEqual([
        ['title', 'invalid_value'],
        ['points', 'invalid_value'],
        ['blocked', 'invalid_value'],
        ['due', 'invalid_value'],
        ['stage', 'invalid_value'],
      ])
      for (const error of result.errors) expect(error.message).not.toBe('')
    }
  })
})

describe('entity schemas', () => {
  it('rejects an attribute whose config does not match its type', () => {
    const bad = { ...base, id: 'a', name: 'A', type: 'select', config: { maxLength: 3 } }
    expect(attributeSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects attribute types outside the implemented set', () => {
    const bad = { ...base, id: 'a', name: 'A', type: 'email', config: {} }
    expect(attributeSchema.safeParse(bad).success).toBe(false)
  })

  it('parses an item and rejects one with a non-scalar value', () => {
    const item = {
      workspaceId: 'w1',
      id: 'i1',
      hubId: 'h1',
      folderId: 'f1',
      seqId: 1,
      values: { title: 'x', points: null },
      version: 1,
      updatedAt: '2026-11-16T10:00:00Z',
      updatedBy: 'p1',
    }
    expect(itemSchema.safeParse(item).success).toBe(true)
    expect(itemSchema.safeParse({ ...item, values: { title: { nested: 1 } } }).success).toBe(false)
    expect(itemSchema.safeParse({ ...item, version: 0 }).success).toBe(false)
  })
})
