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
