import type { Attribute } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { newItemPresets } from './blocks/presets.ts'
import { dataDescription, task } from './data-fixtures.test-utils.ts'
import {
  attributeOf,
  bucketStart,
  doneByDay,
  fieldValue,
  groupLabel,
  groupPreset,
  linkedLabel,
  listFields,
  listGroups,
  measureText,
  type Names,
} from './format.ts'

const a = (id: string) => attributeOf(dataDescription, id) as Attribute
const names: Names = { actor: (id) => (id === 'p-sara' ? 'Sara' : 'Someone'), item: () => 'Epic' }

describe('field values', () => {
  it('shows a select with its option colour, and an empty value as its empty text or nothing', () => {
    expect(fieldValue(a('stage'), 'done', names)).toEqual({ text: 'Done', color: 'green' })
    expect(fieldValue(a('stage'), 'todo', names)).toEqual({ text: 'To do' })
    expect(fieldValue(a('epic'), [], names, 'No epic')).toEqual({ text: 'No epic', empty: true })
    expect(fieldValue(a('points'), null, names)).toBeUndefined()
  })

  it('names actors from the member list and linked items by title', () => {
    expect(fieldValue(a('owner'), ['p-sara'], names)?.text).toBe('Sara')
    expect(fieldValue(a('epic'), ['e1'], names)?.text).toBe('Epic')
    expect(fieldValue(a('key'), 214, names)).toEqual({ text: 'PT-214', mono: true })
  })

  it('puts auto-ID fields before the title and numbers on the right (renderer, not config)', () => {
    const fields = listFields(dataDescription, [
      { attribute: 'key' },
      { attribute: 'points' },
      { attribute: 'gone' },
    ])
    expect(fields).toEqual([
      { key: 'key', label: 'ID', lead: true },
      { key: 'points', label: 'Points', align: 'end' },
    ])
  })

  it('labels linked items it can read, and says when it cannot', () => {
    const linked = {
      e1: { access: 'read' as const, item: task('e1', 3, { title: 'Notifications' }) },
      e2: { access: 'none' as const },
    }
    const hubOf = () => dataDescription
    expect(linkedLabel('e1', linked, hubOf)).toBe('Notifications')
    expect(linkedLabel('e2', linked, hubOf)).toBe('No access')
  })
})

describe('groups and measures', () => {
  it('names each kind of group', () => {
    expect(groupLabel({ kind: 'value', value: 'todo' }, a('stage'), names)).toBe('To do')
    expect(groupLabel({ kind: 'value', value: 'p-sara' }, a('owner'), names)).toBe('Sara')
    expect(
      groupLabel({ kind: 'value', value: 'e1', label: 'Notifications' }, a('epic'), names),
    ).toBe('Notifications')
    expect(groupLabel({ kind: 'empty' }, a('epic'), names)).toBe('No epic')
    expect(groupLabel({ kind: 'no_access' }, a('epic'), names)).toBe('Items you cannot see')
    expect(groupLabel({ kind: 'other' }, a('epic'), names)).toBe('Other')
    expect(groupLabel({ kind: 'value', value: '2026-11-16' }, a('done'), names)).toBe(
      'Nov 16, 2026',
    )
  })

  it('says measures in words', () => {
    const d = dataDescription
    expect(measureText({ fn: 'sum', attribute: 'points' }, 19, d)).toBe('19 points')
    expect(measureText({ fn: 'count_empty', attribute: 'points' }, 1, d)).toBe('1 without points')
    expect(measureText({ fn: 'count' }, 1, d)).toBe('1 item')
    expect(measureText({ fn: 'sum', attribute: 'points' }, null, d)).toBe('No points')
  })

  it('puts a multi-valued row in each of its groups and empty rows in the empty group', () => {
    const items = [
      task('i1', 1, { owner: ['p-sara', 'p-bo'] }),
      task('i2', 2, { owner: ['p-bo'] }),
      task('i3', 3, {}),
    ]
    const groups = listGroups({
      items,
      groups: [
        { key: { kind: 'value', value: 'p-sara' }, values: [1] },
        { key: { kind: 'value', value: 'p-bo' }, values: [2] },
        { key: { kind: 'empty' }, values: [1] },
        { key: { kind: 'no_access' }, values: [4] },
      ],
      attribute: a('owner'),
      measures: [{ fn: 'count' }],
      description: dataDescription,
      names,
      row: (i) => ({ id: i.id, title: i.id, values: {} }),
      more: 0,
    })
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id), g.measures])).toEqual([
      ['Sara', ['i1'], ['1 item']],
      ['Someone', ['i1', 'i2'], ['2 items']],
      ['No owner', ['i3'], ['1 item']],
      ['Items you cannot see', [], ['4 items']],
    ])
  })

  it('buckets dates by day, week from Monday, and month', () => {
    expect(bucketStart('2026-11-18', 'day')).toBe('2026-11-18')
    expect(bucketStart('2026-11-18', 'week')).toBe('2026-11-16')
    expect(bucketStart('2026-11-16', 'week')).toBe('2026-11-16')
    expect(bucketStart('2026-11-22', 'week')).toBe('2026-11-16')
    expect(bucketStart('2026-11-18', 'month')).toBe('2026-11-01')
  })
})

describe('"New item" presets (D77)', () => {
  it('presets the group and the top-level AND equalities, `$me` as the reader', () => {
    const where = {
      and: [
        { attribute: 'owner', op: 'eq' as const, value: { $me: true as const } },
        { attribute: 'points', op: 'gt' as const, value: 1 },
      ],
    }
    const group = groupPreset(
      'v:todo',
      [{ key: { kind: 'value', value: 'todo' }, values: [] }],
      a('stage'),
    )
    expect(newItemPresets(dataDescription, 'b', where, 'p-sara', group)).toEqual({
      owner: ['p-sara'],
      stage: 'todo',
    })
  })

  it('presets nothing from an OR, and no `$me` without a known reader', () => {
    const or = {
      or: [
        { attribute: 'owner', op: 'eq' as const, value: { $me: true as const } },
        { attribute: 'stage', op: 'eq' as const, value: 'todo' },
      ],
    }
    expect(newItemPresets(dataDescription, 'b', or, 'p-sara')).toEqual({})
    const me = { attribute: 'owner', op: 'eq' as const, value: { $me: true as const } }
    expect(newItemPresets(dataDescription, 'b', me, null)).toEqual({})
  })

  it('presets no group for empty, hidden or date groups', () => {
    const groups = [{ key: { kind: 'empty' as const }, values: [] }]
    expect(groupPreset('empty:0', groups, a('stage'))).toBeUndefined()
  })
})

describe('burndown', () => {
  it('turns the remaining series into points done per day', () => {
    expect(
      doneByDay(20, [
        { date: '2026-11-09', remaining: 20 },
        { date: '2026-11-10', remaining: 15 },
        { date: '2026-11-11', remaining: 12 },
        { date: '2026-11-12', remaining: null },
      ]),
    ).toEqual({ '2026-11-10': 5, '2026-11-11': 3 })
  })
})
