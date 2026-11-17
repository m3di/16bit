import { describe, expect, it } from 'vitest'
import { attributeSchema, type Attribute } from './entities.ts'
import { boundedFilterSchema, compileItemQuery, indexEntries, sortSchema } from './query.ts'

const attr = (id: string, type: string, config: object = {}, indexed = true): Attribute =>
  attributeSchema.parse({ workspaceId: 'w', id, hubId: 'h', name: id, type, config, indexed })

const stage = attr('stage', 'select', {
  options: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
})
const due = attr('due', 'date')
const title = attr('title', 'text')
const notes = attr('notes', 'text', {}, false)

describe('indexEntries', () => {
  it('projects one ord 0 row for single-valued types, none for empty or unindexed', () => {
    expect(indexEntries(due, '2026-11-16')).toEqual([
      { ord: 0, column: 'ts', value: '2026-11-16T00:00:00.000Z' },
    ])
    expect(indexEntries(attr('done', 'boolean'), false)).toEqual([
      { ord: 0, column: 'num', value: 0 },
    ])
    expect(indexEntries(due, null)).toEqual([])
    expect(indexEntries(notes, 'x')).toEqual([])
  })
})

describe('compileItemQuery expand', () => {
  const rel = attr('rel', 'relation', { targetHubId: 'h' }, false)
  const compile = (expand: string[]) =>
    compileItemQuery([title, rel], { where: null, sort: [], expand })

  it('accepts relation attributes of the folder, indexed or not', () => {
    expect(compile(['rel'])).toEqual({ ok: true, where: null, sort: [], expand: ['rel'] })
    expect(compileItemQuery([rel], { where: null, sort: [] })).toMatchObject({ expand: [] })
  })

  it('refuses other attributes, naming each', () => {
    expect(compile(['title', 'gone'])).toEqual({
      ok: false,
      errors: [
        {
          path: 'expand.0',
          message: 'Attribute "title" is a text attribute; only relations can be expanded',
        },
        { path: 'expand.1', message: 'Attribute "gone" is not an attribute of this folder' },
      ],
    })
  })
})

describe('compileItemQuery', () => {
  const compile = (where: unknown, sort: unknown = []) =>
    compileItemQuery([stage, due, title, notes], {
      where: boundedFilterSchema.nullable().parse(where),
      sort: sortSchema.parse(sort),
    })

  it('projects operands like stored values and resolves sort keys', () => {
    expect(
      compile({ and: [{ attribute: 'due', op: 'gte', value: '2026-11-16' }] }, [
        { attribute: 'stage', direction: 'desc' },
        { attribute: 'title' },
      ]),
    ).toEqual({
      ok: true,
      where: {
        and: [
          {
            condition: {
              attributeId: 'due',
              column: 'ts',
              op: 'gte',
              operands: ['2026-11-16T00:00:00.000Z'],
            },
          },
        ],
      },
      sort: [
        {
          attributeId: 'stage',
          column: 'txt',
          direction: 'desc',
          key: { by: 'position', order: ['a', 'b'] },
        },
        { attributeId: 'title', column: 'txt', direction: 'asc', key: { by: 'lower' } },
      ],
      expand: [],
    })
  })

  it('collects every error with its path', () => {
    const result = compile({
      or: [
        { attribute: 'notes', op: 'eq', value: 'x' },
        { attribute: 'stage', op: 'contains', value: 'a' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.path)).toEqual(['where.or.0', 'where.or.1'])
  })
})

describe('M1 types in queries', () => {
  const tags = attr('tags', 'multi_select', {
    options: [
      { id: 'bug', label: 'Bug' },
      { id: 'ui', label: 'UI' },
    ],
  })
  const owner = attr('owner', 'actor')
  const parent = attr('parent', 'relation', { targetHubId: 'h' })
  const body = attr('body', 'rich_text')
  const site = attr('site', 'url')
  const key = attr('key', 'auto_id')
  const compile = (where: unknown, sort: unknown = []) =>
    compileItemQuery([tags, owner, parent, body, site, key], {
      where: boundedFilterSchema.nullable().parse(where),
      sort: sortSchema.parse(sort),
    })

  it('indexes one row per list element, in option order for multi-select', () => {
    expect(indexEntries(tags, ['ui', 'bug'])).toEqual([
      { ord: 0, column: 'txt', value: 'bug' },
      { ord: 1, column: 'txt', value: 'ui' },
    ])
    expect(indexEntries(parent, ['i2', 'i1']).map((e) => e.value)).toEqual(['i2', 'i1'])
    expect(indexEntries(key, 12)).toEqual([{ ord: 0, column: 'num', value: 12 }])
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
    }
    expect(indexEntries(body, doc as never)).toEqual([{ ord: 0, column: 'txt', value: 'Hi' }])
  })

  it('checks each list operand as one element', () => {
    expect(
      compile({
        and: [
          { attribute: 'tags', op: 'in', value: ['bug', 'ui'] },
          { attribute: 'owner', op: 'not_in', value: ['p1'] },
          { attribute: 'parent', op: 'in', value: ['i1'] },
          { attribute: 'key', op: 'gt', value: 10 },
          { attribute: 'body', op: 'contains', value: 'hi' },
          { attribute: 'site', op: 'starts_with', value: 'https://' },
        ],
      }),
    ).toMatchObject({ ok: true })
    const bad = compile({
      and: [
        { attribute: 'tags', op: 'in', value: ['nope'] },
        { attribute: 'owner', op: 'in', value: [['p1']] },
        { attribute: 'tags', op: 'eq', value: 'bug' },
        { attribute: 'body', op: 'eq', value: 'x' },
        { attribute: 'key', op: 'eq', value: 0 },
      ],
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.errors.map((e) => e.path)).toEqual([
        'where.and.0.value',
        'where.and.1.value',
        'where.and.2',
        'where.and.3',
        'where.and.4.value',
      ])
      expect(bad.errors[0]?.message).toContain('Unknown option')
    }
  })

  it('sorts multi-select by option order and url by case, and refuses the unsortable types', () => {
    expect(
      compile(null, [{ attribute: 'tags' }, { attribute: 'site' }, { attribute: 'key' }]),
    ).toMatchObject({
      ok: true,
      sort: [
        { attributeId: 'tags', key: { by: 'position', order: ['bug', 'ui'] } },
        { attributeId: 'site', key: { by: 'lower' } },
        { attributeId: 'key', column: 'num', key: { by: 'value' } },
      ],
    })
    const refused = compile(null, [
      { attribute: 'owner' },
      { attribute: 'parent' },
      { attribute: 'body' },
    ])
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.errors.map((e) => e.path)).toEqual(['sort.0', 'sort.1', 'sort.2'])
      expect(refused.errors[0]?.message).toContain('cannot be sorted')
    }
  })
})
