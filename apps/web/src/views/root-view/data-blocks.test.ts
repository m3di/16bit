import { parseViewTree, type Block, type BlockInput, type BlockStatus } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import BoardBlock from './blocks/BoardBlock.vue'
import ChartBlock from './blocks/ChartBlock.vue'
import FieldsBlock from './blocks/FieldsBlock.vue'
import ListBlock from './blocks/ListBlock.vue'
import NumberBlock from './blocks/NumberBlock.vue'
import TableBlock from './blocks/TableBlock.vue'
import { dataDescription, plain, renderWith, task, testHost } from './data-fixtures.test-utils.ts'
import { page } from './fixtures.test-utils.ts'
import type { BlockLoad } from './useRootView.ts'

/** A block as `parseViewTree` reads it, defaults filled in. */
function parsed(input: BlockInput, siblings: BlockInput[] = []): Block {
  const tree = parseViewTree(page([input, ...siblings]))
  if (!tree.ok) throw new Error(JSON.stringify(tree.errors))
  const block = tree.tree.root.children?.[0]
  if (!block) throw new Error('no block')
  return block
}

const headings = (html: string) =>
  [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => plain(m[1] ?? ''))

const ok = (status: BlockStatus): BlockLoad => ({
  state: 'ready',
  status,
})

const backlog = [
  task('i1', 214, {
    title: 'Label printer',
    key: 214,
    stage: 'done',
    points: 5,
    owner: ['p-sara'],
    epic: ['e1'],
  }),
  task('i2', 215, { title: 'Retry queue', key: 215, stage: 'todo' }),
  task('i3', 216, { title: 'Webhooks', key: 216, stage: 'todo', points: 3 }),
]
const linked = {
  e1: {
    access: 'read' as const,
    item: { ...task('e1', 3, { title: 'Notifications' }), folderId: 'bld' },
  },
}

const listBlock = (more: Record<string, unknown> = {}) =>
  parsed({
    id: 'backlog',
    type: 'list',
    config: {
      binding: { folderId: 'b', where: { attribute: 'owner', op: 'in', value: [{ $me: true }] } },
      fields: [
        { attribute: 'key' },
        { attribute: 'epic', emptyText: 'No epic' },
        { attribute: 'stage' },
        { attribute: 'points', emptyText: '?' },
      ],
      ...more,
    },
  })

describe('list block', () => {
  it('shows the ID first, then the title and fields, with empty texts and option dots', async () => {
    const html = await renderWith(ListBlock, {
      block: listBlock(),
      load: ok({ status: 'ok', data: { kind: 'items', items: backlog, total: 3, linked } }),
      level: 3,
    })
    const text = plain(html)
    expect(text).toContain('PT-214')
    expect(text.indexOf('PT-214')).toBeLessThan(text.indexOf('Label printer'))
    expect(text).toContain('Notifications')
    expect(text).toContain('No epic')
    expect(text).toContain('?')
    // The select's colour as a dot beside its name (Done is green).
    expect(html).toContain('--pal-green')
    // Rows open the item's panel.
    expect(html).toContain('href="/w/w/hubs/bld/home?item=i1"')
  })

  it('groups rows by the server’s groups with their measures, empty group included', async () => {
    const block = listBlock({
      groupBy: {
        attribute: 'stage',
        measures: [
          { fn: 'sum', attribute: 'points' },
          { fn: 'count_empty', attribute: 'points' },
        ],
      },
      create: true,
    })
    const html = await renderWith(ListBlock, {
      block,
      load: ok({
        status: 'ok',
        data: {
          kind: 'items',
          items: backlog,
          total: 3,
          groups: [
            { key: { kind: 'value', value: 'todo' }, values: [3, 1] },
            { key: { kind: 'value', value: 'done' }, values: [5, 0] },
            { key: { kind: 'empty' }, values: [null, 0] },
          ],
          linked,
        },
      }),
      level: 3,
    })
    const text = plain(html)
    expect(text).toMatch(/To do .*3 points, 1 without points/)
    expect(text).toMatch(/Done .*5 points, 0 without points/)
    expect(text).toContain('No stage')
    expect(text.indexOf('Retry queue')).toBeLessThan(text.indexOf('Label printer'))
    expect(html.match(/<h3/g)?.length).toBe(3)
    expect(text).toContain('New item')
  })

  it('groups by the server’s groups when the grouping has no measures', async () => {
    const html = await renderWith(ListBlock, {
      block: listBlock({ groupBy: { attribute: 'stage' } }),
      load: ok({
        status: 'ok',
        data: {
          kind: 'items',
          items: backlog,
          total: 3,
          groups: [
            { key: { kind: 'value', value: 'todo' }, values: [] },
            { key: { kind: 'value', value: 'done' }, values: [] },
          ],
          linked,
        },
      }),
      level: 3,
    })
    expect(headings(html)).toEqual(['To do', 'Done'])
    const text = plain(html)
    expect(text.indexOf('To do')).toBeLessThan(text.indexOf('Retry queue'))
    expect(text.indexOf('Done')).toBeLessThan(text.indexOf('Label printer'))
    expect(text.indexOf('Retry queue')).toBeLessThan(text.indexOf('Done'))
  })

  it('hides "New item" without `item.write`, or when the block does not offer it', async () => {
    const load = ok({ status: 'ok', data: { kind: 'items', items: backlog, total: 3 } })
    const refused = await renderWith(
      ListBlock,
      { block: listBlock({ create: true }), load, level: 3 },
      testHost({ canCreate: () => false }),
    )
    expect(plain(refused)).not.toContain('New item')
    const off = await renderWith(ListBlock, { block: listBlock(), load, level: 3 })
    expect(plain(off)).not.toContain('New item')
  })

  it('shows rows as the store has them now, and drops deleted ones (D60)', async () => {
    const html = await renderWith(
      ListBlock,
      {
        block: listBlock(),
        load: ok({ status: 'ok', data: { kind: 'items', items: backlog, total: 3 } }),
        level: 3,
      },
      testHost({
        current: (i) =>
          i.id === 'i3'
            ? undefined
            : i.id === 'i2'
              ? { ...i, values: { ...i.values, title: 'Renamed' } }
              : i,
      }),
    )
    const text = plain(html)
    expect(text).toContain('Renamed')
    expect(text).not.toContain('Webhooks')
  })

  it('says how many more there are past the limit', async () => {
    const html = await renderWith(ListBlock, {
      block: listBlock(),
      load: ok({ status: 'ok', data: { kind: 'items', items: backlog, total: 15 } }),
      level: 3,
    })
    expect(plain(html)).toContain('+12 more')
  })

  it('keeps each state in its own place', async () => {
    const html = await renderWith(ListBlock, {
      block: listBlock(),
      load: ok({ status: 'unresolved', blocks: ['sprint'] }),
      level: 3,
    })
    expect(plain(html)).toContain('Nothing to show yet')
  })
})

describe('board block', () => {
  const block = parsed({
    id: 'work',
    type: 'board',
    config: {
      binding: { folderId: 'b' },
      column: {
        attribute: 'stage',
        options: [{ option: 'todo' }, { option: 'done', emptyText: 'Nothing done yet.' }],
      },
      fields: [{ attribute: 'key' }, { attribute: 'points', emptyText: '?' }],
      create: true,
    },
  })

  it('shows the configured columns in order, empty ones with their text, and "+N more"', async () => {
    const html = await renderWith(BoardBlock, {
      block,
      load: ok({
        status: 'ok',
        data: {
          kind: 'board',
          columns: [
            { option: 'todo', items: [backlog[1], backlog[2]].filter((x) => !!x), total: 30 },
            { option: 'done', items: [], total: 0 },
          ],
        },
      }),
      level: 3,
    })
    const text = plain(html)
    expect(text.indexOf('To do')).toBeLessThan(text.indexOf('Done'))
    expect(text).toContain('Nothing done yet.')
    expect(text).toMatch(/PT-216 ?, 3/)
    expect(text).toMatch(/PT-215 ?, \?/)
    expect(text).toContain('+28 more')
    expect(text).toContain('New item')
  })
})

describe('number block', () => {
  it('shows a measure "of" another', async () => {
    const block = parsed({
      id: 'open',
      type: 'number',
      config: {
        kind: 'aggregate',
        label: 'Points done',
        binding: { folderId: 'b' },
        value: { fn: 'sum', attribute: 'points' },
        total: { fn: 'sum', attribute: 'points' },
      },
    })
    const html = await renderWith(NumberBlock, {
      block,
      load: ok({
        status: 'ok',
        data: {
          kind: 'aggregate',
          groups: [{ key: { kind: 'all' }, values: [16, 34] }],
          truncated: false,
        },
      }),
      level: 3,
    })
    expect(plain(html)).toContain('Points done 16 of 34')
  })

  it('shows the day of a sprint, and says so outside its dates', async () => {
    const block = parsed({
      id: 'day',
      type: 'number',
      config: {
        kind: 'days',
        label: 'Sprint day',
        binding: { by: 'item', folderId: 'sp', itemId: 's1' },
        start: 'start',
        end: 'end',
      },
    })
    const day = (d: number | null, of: number | null) =>
      renderWith(NumberBlock, {
        block,
        load: ok({ status: 'ok', data: { kind: 'days', day: d, of } }),
        level: 3,
      })
    expect(plain(await day(6, 10))).toContain('Sprint day 6 of 10')
    expect(plain(await day(null, 10))).toContain('Outside its dates')
    expect(plain(await day(null, null))).toContain('No dates')
  })
})

describe('chart block', () => {
  it('draws a bar per group with its value in words, people by name', async () => {
    const block = parsed({
      id: 'team',
      type: 'chart',
      config: {
        kind: 'bars',
        binding: { folderId: 'b' },
        groupBy: { attribute: 'owner' },
        measures: [{ fn: 'sum', attribute: 'points' }],
      },
    })
    const html = await renderWith(ChartBlock, {
      block,
      load: ok({
        status: 'ok',
        data: {
          kind: 'aggregate',
          groups: [
            { key: { kind: 'value', value: 'p-sara' }, values: [10] },
            { key: { kind: 'value', value: 'p-unknown-agent' }, values: [4] },
            { key: { kind: 'empty' }, values: [2] },
            { key: { kind: 'value', value: 'p-ray' }, values: [null] },
          ],
          truncated: false,
        },
      }),
      level: 3,
    })
    const text = plain(html)
    expect(text).toContain('Sara')
    expect(text).toContain('10')
    expect(text).toContain('No owner')
    // A sum over no points has no value: a dash, not 0.
    expect(html).toContain('—')
    expect(html).toContain('data-block-state="ready"')
  })

  it('draws a burndown from the remaining points per day', async () => {
    const block = parsed(
      {
        id: 'burn',
        type: 'chart',
        config: {
          kind: 'burndown',
          binding: { folderId: 'b' },
          range: { block: 'sprint', start: 'start', end: 'end' },
          doneOn: 'done',
          points: 'points',
        },
      },
      [
        {
          id: 'sprint',
          type: 'fields',
          config: { binding: { by: 'item', folderId: 'sp', itemId: 's1' }, fields: ['title'] },
        },
      ],
    )
    const html = await renderWith(ChartBlock, {
      block,
      load: ok({
        status: 'ok',
        data: {
          kind: 'burndown',
          start: '2026-11-09',
          end: '2026-11-13',
          today: '2026-11-11',
          total: 20,
          days: [
            { date: '2026-11-09', remaining: 20 },
            { date: '2026-11-10', remaining: 15 },
            { date: '2026-11-11', remaining: 12 },
            { date: '2026-11-12', remaining: null },
            { date: '2026-11-13', remaining: null },
          ],
        },
      }),
      level: 3,
    })
    expect(html).toContain('<svg')
    expect(plain(html)).toContain('12')
  })
})

describe('fields block', () => {
  const block = parsed({
    id: 'sprint',
    type: 'fields',
    config: {
      binding: {
        by: 'rule',
        folderId: 'sp',
        where: { attribute: 'start', op: 'lte', value: { $now: 'P0D' } },
      },
      fields: ['title', 'start', 'end'],
      layout: 'inline',
    },
  })

  it('shows the item’s fields inline', async () => {
    const html = await renderWith(FieldsBlock, {
      block,
      load: ok({
        status: 'ok',
        data: {
          kind: 'item',
          item: {
            ...task('s1', 24, { title: 'Sprint 24', start: '2026-11-09', end: '2026-11-20' }),
            folderId: 'sp',
          },
        },
      }),
      level: 3,
    })
    const text = plain(html)
    expect(text).toContain('Sprint 24')
    expect(text).toContain('Nov 9, 2026')
    expect(text).toContain('Nov 20, 2026')
  })

  it('has nothing to show yet when its rule finds no item (no current sprint)', async () => {
    const html = await renderWith(FieldsBlock, {
      block,
      load: ok({ status: 'ok', data: { kind: 'item', item: null } }),
      level: 3,
    })
    expect(plain(html)).toContain('Nothing to show yet')
  })
})

describe('table block', () => {
  it('shows the folder’s columns for the rows read, and how many more there are', async () => {
    const block = parsed({ id: 't', type: 'table', config: { binding: { folderId: 'b' } } })
    const html = await renderWith(TableBlock, {
      block,
      load: ok({ status: 'ok', data: { kind: 'items', items: backlog, total: 80 } }),
      level: 3,
    })
    const text = plain(html)
    expect(text).toContain('Label printer')
    expect(text).toContain('Showing 3 of 80 items')
    expect(html).toContain('href="/w/w/hubs/bld/home?item=i1"')
    expect(dataDescription.folders.some((f) => f.id === 'b')).toBe(true)
  })

  it('shows "invalid" for a block that names a removed attribute', async () => {
    const block = parsed({ id: 't', type: 'table', config: { binding: { folderId: 'b' } } })
    const html = await renderWith(TableBlock, {
      block,
      load: ok({ status: 'invalid', errors: [{ path: 'root', message: 'Removed' }] }),
      level: 3,
    })
    expect(plain(html)).toContain('This block needs fixing')
  })
})
