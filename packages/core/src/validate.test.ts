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

  it("parses an item and rejects a value of no attribute type's shape", () => {
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
    expect(itemSchema.safeParse({ ...item, values: { tags: [1] } }).success).toBe(false)
    expect(itemSchema.safeParse({ ...item, version: 0 }).success).toBe(false)
    const listsAndDocs = { tags: ['a'], notes: { type: 'doc', content: [] } }
    expect(itemSchema.safeParse({ ...item, values: listsAndDocs }).success).toBe(true)
  })

  it('keeps relations inside their hub unless crossHub is on (D11)', () => {
    const relation = { ...base, id: 'rel', name: 'Rel', type: 'relation' }
    const same = { ...relation, config: { targetHubId: 'h1' } }
    const other = { ...relation, config: { targetHubId: 'h2' } }
    expect(attributeSchema.safeParse(same).success).toBe(true)
    const refused = attributeSchema.safeParse(other)
    expect(refused.error?.issues[0]?.path).toEqual(['config', 'targetHubId'])
    const allowed = { ...relation, config: { targetHubId: 'h2', crossHub: true } }
    expect(attributeSchema.safeParse(allowed).success).toBe(true)
  })
})

describe('validateItemValues with M1 types', () => {
  const tags = attr({
    id: 'tags',
    name: 'Tags',
    type: 'multi_select',
    config: { options: [{ id: 'bug', label: 'Bug' }] },
  })
  const key = attr({ id: 'key', name: 'Key', type: 'auto_id', config: { prefix: 'BLD' } })
  const body = attr({ id: 'body', name: 'Body', type: 'rich_text', config: {} })
  const owner = attr({ id: 'owner', name: 'Owner', type: 'actor', config: {} })
  const site = attr({ id: 'site', name: 'Site', type: 'url', config: {} })
  const parent = attr({
    id: 'parent',
    name: 'Parent',
    type: 'relation',
    config: { targetHubId: 'h1', multiple: false },
  })
  const m1: FolderAttributeDefinition[] = [
    { attribute: tags, required: true },
    { attribute: key, required: true },
    { attribute: body, required: false },
    { attribute: owner, required: false },
    { attribute: site, required: false },
    { attribute: parent, required: false },
  ]
  const doc = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
  }

  it('accepts valid values and does not require the server-assigned auto ID', () => {
    const values = {
      tags: ['bug'],
      body: doc,
      owner: ['p1'],
      site: 'https://a.com',
      parent: ['i1'],
    }
    expect(validateItemValues(m1, values)).toEqual({ ok: true, values })
  })

  it('refuses any client value for auto ID, including null, on create and patch', () => {
    for (const value of [7, null]) {
      expect(validateItemValues(m1, { tags: ['bug'], key: value })).toEqual({
        ok: false,
        errors: [{ attributeId: 'key', code: 'read_only', message: 'Assigned by the server' }],
      })
      expect(validateItemValues(m1, { key: value }, { partial: true })).toMatchObject({
        ok: false,
        errors: [{ attributeId: 'key', code: 'read_only' }],
      })
    }
  })

  it('stores empty lists and empty documents as null, so required still bites', () => {
    const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }
    expect(validateItemValues(m1, { tags: ['bug'], body: emptyDoc, owner: [] })).toEqual({
      ok: true,
      values: { tags: ['bug'], body: null, owner: null },
    })
    expect(validateItemValues(m1, { tags: [] })).toMatchObject({
      ok: false,
      errors: [{ attributeId: 'tags', code: 'required' }],
    })
  })

  it("reports invalid values with the type's message", () => {
    const result = validateItemValues(
      m1,
      {
        tags: ['nope'],
        body: { type: 'doc', content: [{ type: 'image' }] },
        owner: ['p1', 'p2'],
        site: 'javascript:alert(1)',
        parent: 'i1',
      },
      { partial: true },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.map((e) => [e.attributeId, e.code])).toEqual([
        ['tags', 'invalid_value'],
        ['body', 'invalid_value'],
        ['owner', 'invalid_value'],
        ['site', 'invalid_value'],
        ['parent', 'invalid_value'],
      ])
      expect(result.errors[1]?.message).toBe('"image" is not an allowed block at content.0.type')
    }
  })
})
