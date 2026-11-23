import { describe, expect, it } from 'vitest'
import {
  aggregateRequestSchema,
  attributeSchema,
  BLOCK_TYPE_NAMES,
  BLOCK_TYPES,
  checkAggregate,
  checkFilterOperands,
  checkViewTree,
  createPresets,
  createFolderSchema,
  defaultViewTree,
  folderSchema,
  hubSchema,
  itemQuerySchema,
  MAX_VIEW_BYTES,
  parseViewTree,
  resolveFilterOperands,
  updateHubSchema,
  viewDataQuerySchema,
  viewDataSchema,
  type Attribute,
  type BlockInput,
  type Filter,
  type ViewSchemaContext,
  type ViewTree,
} from './index.ts'

// Contracts for root views, blocks, aggregates and view data (#252, D76 to D83).

const attr = (id: string, type: string, config: object = {}, indexed = true): Attribute =>
  attributeSchema.parse({
    workspaceId: 'w',
    id,
    hubId: 'h',
    name: id,
    type,
    config,
    indexed,
    version: 0,
  })

const stage = attr('stage', 'select', {
  options: [
    { id: 'todo', label: 'Todo' },
    { id: 'review', label: 'Review' },
    { id: 'done', label: 'Done' },
  ],
})
const points = attr('points', 'number')
const owner = attr('owner', 'actor')
const sprint = attr('sprint', 'relation', { targetHubId: 'h' })
const doneOn = attr('done-on', 'date')
const title = attr('title', 'text')
const notes = attr('notes', 'text', {}, false)
const start = attr('start', 'date')
const end = attr('end', 'date')
const backlogAttrs = [title, stage, points, owner, sprint, doneOn, notes]
const sprintAttrs = [title, start, end]

const context: ViewSchemaContext = {
  folders: new Map([
    ['h', { viewsOnly: false, attributes: [] }],
    ['home', { viewsOnly: true, attributes: [] }],
    ['backlog', { viewsOnly: false, attributes: backlogAttrs }],
    ['sprints', { viewsOnly: false, attributes: sprintAttrs }],
  ]),
}

const me = { $me: true }
const currentSprint: BlockInput = {
  id: 'current-sprint',
  type: 'fields',
  config: {
    binding: {
      by: 'rule',
      folderId: 'sprints',
      where: {
        and: [
          { attribute: 'start', op: 'lte', value: { $now: 'P0D' } },
          { attribute: 'end', op: 'gte', value: { $now: 'P0D' } },
        ],
      },
    },
    fields: ['title', 'start', 'end'],
    layout: 'inline',
  },
}
const inSprint: Filter = { attribute: 'sprint', op: 'in', value: [{ $block: 'current-sprint' }] }

/** One valid block of every type, so each is exercised. */
const VALID: Record<(typeof BLOCK_TYPE_NAMES)[number], BlockInput> = {
  page: { id: 'p', type: 'page', config: { title: 'Home' } },
  section: { id: 's', type: 'section', config: { title: 'This sprint' } },
  columns: { id: 'c', type: 'columns', config: {} },
  heading: { id: 'h1', type: 'heading', config: { text: 'My work', level: 1 } },
  text: { id: 't', type: 'text', config: { text: 'Plain text.' } },
  table: { id: 'tbl', type: 'table', config: { binding: { folderId: 'backlog', limit: 50 } } },
  list: {
    id: 'lst',
    type: 'list',
    config: {
      binding: {
        folderId: 'backlog',
        where: inSprint,
        sort: [{ attribute: 'points' }],
        limit: 100,
      },
      fields: [{ attribute: 'stage' }, { attribute: 'sprint', emptyText: 'No sprint' }],
      groupBy: {
        attribute: 'stage',
        measures: [
          { fn: 'sum', attribute: 'points' },
          { fn: 'count_empty', attribute: 'points' },
        ],
      },
      create: true,
    },
  },
  board: {
    id: 'brd',
    type: 'board',
    config: {
      binding: {
        folderId: 'backlog',
        where: { attribute: 'owner', op: 'in', value: [me] },
        limit: 25,
      },
      column: {
        attribute: 'stage',
        options: [
          { option: 'todo' },
          { option: 'review', emptyText: 'Nothing of yours is in review.' },
        ],
      },
      fields: [{ attribute: 'points', emptyText: '?' }],
    },
  },
  number: {
    id: 'num',
    type: 'number',
    config: {
      kind: 'aggregate',
      label: 'Points done',
      binding: { folderId: 'backlog', where: inSprint },
      value: {
        fn: 'sum',
        attribute: 'points',
        where: { attribute: 'stage', op: 'eq', value: 'done' },
      },
      total: { fn: 'sum', attribute: 'points' },
    },
  },
  chart: {
    id: 'burn',
    type: 'chart',
    config: {
      kind: 'burndown',
      binding: { folderId: 'backlog', where: inSprint },
      range: { block: 'current-sprint', start: 'start', end: 'end' },
      doneOn: 'done-on',
      points: 'points',
    },
  },
  fields: currentSprint,
}

const tree = (...children: BlockInput[]) => ({
  schemaVersion: 1,
  root: { id: 'root', type: 'page', config: {}, children },
})
const parsed = (raw: unknown): ViewTree => {
  const result = parseViewTree(raw)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.tree
}
const errorsOf = (raw: unknown) => {
  const result = parseViewTree(raw)
  return result.ok ? [] : result.errors
}

describe('BLOCK_TYPES registry (D14, D77)', () => {
  it('has the 11 M4 block types, each with a category, children and bindings', () => {
    expect(Object.keys(BLOCK_TYPES).sort()).toEqual([...BLOCK_TYPE_NAMES].sort())
    expect(BLOCK_TYPE_NAMES).toHaveLength(11)
    for (const name of BLOCK_TYPE_NAMES) {
      const def = BLOCK_TYPES[name]
      expect(['layout', 'content', 'data']).toContain(def.category)
      expect(def.bindings.length).toBeGreaterThan(0)
      // Only layouts hold children, and no type allows a page (D14: no loops through the root).
      expect(def.children.length > 0).toBe(def.category === 'layout')
      expect(def.children).not.toContain('page')
    }
    expect(BLOCK_TYPE_NAMES.filter((n) => BLOCK_TYPES[n].root)).toEqual(['page'])
  })
})

describe('parseViewTree: every block type', () => {
  for (const name of BLOCK_TYPE_NAMES) {
    it(`accepts a valid ${name}`, () => {
      const block = VALID[name]
      const raw =
        name === 'page'
          ? { schemaVersion: 1, root: block }
          : tree(currentSprint, ...(name === 'fields' ? [] : [block]))
      expect(errorsOf(raw)).toEqual([])
    })
  }

  const INVALID: [string, BlockInput | Record<string, unknown>, string][] = [
    [
      'heading without text',
      { id: 'x', type: 'heading', config: {} },
      'root.children.0.config.text',
    ],
    [
      'heading level 4',
      { id: 'x', type: 'heading', config: { text: 'a', level: 4 } },
      'root.children.0.config.level',
    ],
    [
      'empty text',
      { id: 'x', type: 'text', config: { text: '  ' } },
      'root.children.0.config.text',
    ],
    [
      'section with an unknown key',
      { id: 'x', type: 'section', config: { color: 'red' } },
      'root.children.0.config',
    ],
    [
      'columns with config',
      { id: 'x', type: 'columns', config: { gap: 2 } },
      'root.children.0.config',
    ],
    [
      'table without binding',
      { id: 'x', type: 'table', config: {} },
      'root.children.0.config.binding',
    ],
    [
      'table over 100 rows',
      { id: 'x', type: 'table', config: { binding: { folderId: 'backlog', limit: 101 } } },
      'root.children.0.config.binding.limit',
    ],
    [
      'list with 5 fields',
      {
        id: 'x',
        type: 'list',
        config: {
          binding: { folderId: 'backlog' },
          fields: ['a', 'b', 'c', 'd', 'e'].map((attribute) => ({ attribute })),
        },
      },
      'root.children.0.config.fields',
    ],
    [
      'list with 3 group measures',
      {
        id: 'x',
        type: 'list',
        config: {
          binding: { folderId: 'backlog' },
          groupBy: {
            attribute: 'stage',
            measures: [{ fn: 'count' }, { fn: 'count' }, { fn: 'count' }],
          },
        },
      },
      'root.children.0.config.groupBy.measures',
    ],
    [
      'board with 26 cards per column',
      {
        id: 'x',
        type: 'board',
        config: {
          binding: { folderId: 'backlog', limit: 26 },
          column: { attribute: 'stage', options: [{ option: 'todo' }] },
        },
      },
      'root.children.0.config.binding.limit',
    ],
    [
      'board with 21 columns',
      {
        id: 'x',
        type: 'board',
        config: {
          binding: { folderId: 'backlog' },
          column: {
            attribute: 'stage',
            options: Array.from({ length: 21 }, (_, i) => ({ option: `o${String(i)}` })),
          },
        },
      },
      'root.children.0.config.column.options',
    ],
    [
      'number of an unknown kind',
      { id: 'x', type: 'number', config: { kind: 'ratio', binding: { folderId: 'backlog' } } },
      'root.children.0.config.kind',
    ],
    [
      'number sum without attribute',
      {
        id: 'x',
        type: 'number',
        config: { kind: 'aggregate', binding: { folderId: 'backlog' }, value: { fn: 'sum' } },
      },
      'root.children.0.config.value.attribute',
    ],
    [
      'number days counting hours',
      {
        id: 'x',
        type: 'number',
        config: {
          kind: 'days',
          binding: { by: 'item', folderId: 'sprints', itemId: 's1' },
          start: 'start',
          end: 'end',
          days: 'hours',
        },
      },
      'root.children.0.config.days',
    ],
    [
      'chart bars without measures',
      {
        id: 'x',
        type: 'chart',
        config: {
          kind: 'bars',
          binding: { folderId: 'backlog' },
          groupBy: { attribute: 'stage' },
          measures: [],
        },
      },
      'root.children.0.config.measures',
    ],
    [
      'fields without fields',
      {
        id: 'x',
        type: 'fields',
        config: { binding: { by: 'item', folderId: 'sprints', itemId: 's1' }, fields: [] },
      },
      'root.children.0.config.fields',
    ],
    [
      'fields with a set binding',
      { id: 'x', type: 'fields', config: { binding: { folderId: 'sprints' }, fields: ['title'] } },
      'root.children.0.config.binding.by',
    ],
    ['an unknown block type', { id: 'x', type: 'tabs', config: {} }, 'root.children.0.type'],
  ]
  for (const [name, block, path] of INVALID) {
    it(`refuses ${name}`, () => {
      expect(errorsOf(tree(block as BlockInput)).map((e) => e.path)).toContain(path)
    })
  }
})

describe('parseViewTree: structure (D14, D77)', () => {
  it('refuses a page that is not the root, and a root that is not a page', () => {
    expect(errorsOf(tree({ id: 'p2', type: 'page', config: {} }))).toEqual([
      { path: 'root.children.0.type', message: 'A page is only ever the root block' },
    ])
    expect(errorsOf({ schemaVersion: 1, root: { id: 's', type: 'section', config: {} } })).toEqual([
      { path: 'root.type', message: 'The root block is a page' },
    ])
  })

  it('refuses a child its parent does not allow, and children on a leaf', () => {
    const inSection = tree({
      id: 's',
      type: 'section',
      config: {},
      children: [{ id: 's2', type: 'section', config: {} }],
    })
    expect(errorsOf(inSection)).toEqual([
      {
        path: 'root.children.0.children.0.type',
        message: 'A section block cannot hold a section block',
      },
    ])
    const leaf = tree({
      id: 'h',
      type: 'heading',
      config: { text: 'a' },
      children: [{ id: 't', type: 'text', config: { text: 'b' } }],
    })
    expect(errorsOf(leaf).map((e) => e.message)).toContain('A heading block has no children')
  })

  it('refuses duplicate block IDs', () => {
    const dup = tree(
      { id: 'a', type: 'text', config: { text: 'x' } },
      { id: 'a', type: 'text', config: { text: 'y' } },
    )
    expect(errorsOf(dup)).toEqual([
      { path: 'root.children.1.id', message: 'Block ID "a" is already used at root.children.0' },
    ])
  })

  it('refuses more than 4 columns', () => {
    const cols = Array.from({ length: 5 }, (_, i) => ({
      id: `t${String(i)}`,
      type: 'text' as const,
      config: { text: 'x' },
    }))
    expect(
      errorsOf(tree({ id: 'c', type: 'columns', config: {}, children: cols })).map(
        (e) => e.message,
      ),
    ).toEqual(['At most 4 columns'])
  })

  it('refuses a tree deeper than 8', () => {
    // page > (section > columns) x 4 > text: depth 10.
    let block: BlockInput = { id: 'leaf', type: 'text', config: { text: 'x' } }
    for (let i = 0; i < 4; i++) {
      block = { id: `c${String(i)}`, type: 'columns', config: {}, children: [block] }
      block = { id: `s${String(i)}`, type: 'section', config: {}, children: [block] }
    }
    const messages = errorsOf(tree(block)).map((e) => e.message)
    expect(messages).toContain('Blocks nest at most 8 levels deep')
    // Depth 8 exactly is fine: page > (section > columns) x 3 > text.
    let ok: BlockInput = { id: 'leaf', type: 'text', config: { text: 'x' } }
    for (let i = 0; i < 3; i++) {
      ok = { id: `c${String(i)}`, type: 'columns', config: {}, children: [ok] }
      ok = { id: `s${String(i)}`, type: 'section', config: {}, children: [ok] }
    }
    expect(errorsOf(tree(ok))).toEqual([])
  })

  it('refuses over 200 blocks and over 20 data blocks', () => {
    const texts = Array.from({ length: 200 }, (_, i) => ({
      id: `t${String(i)}`,
      type: 'text' as const,
      config: { text: 'x' },
    }))
    expect(errorsOf(tree(...texts)).map((e) => e.message)).toContain(
      'A view has at most 200 blocks',
    )
    expect(errorsOf(tree(...texts.slice(0, 199)))).toEqual([])
    const tables = Array.from({ length: 21 }, (_, i) => ({
      id: `tbl${String(i)}`,
      type: 'table' as const,
      config: { binding: { folderId: 'backlog' } },
    }))
    expect(errorsOf(tree(...tables)).map((e) => e.message)).toEqual([
      'A view has at most 20 data blocks',
    ])
    expect(errorsOf(tree(...tables.slice(0, 20)))).toEqual([])
  })

  it('refuses a tree over 128 KiB', () => {
    const big = Array.from({ length: 30 }, (_, i) => ({
      id: `t${String(i)}`,
      type: 'text' as const,
      config: { text: 'é'.repeat(2500) },
    }))
    expect(JSON.stringify(tree(...big)).length).toBeLessThan(MAX_VIEW_BYTES) // UTF-16 units
    expect(errorsOf(tree(...big))).toEqual([{ path: '', message: 'A view is at most 128 KiB' }])
  })

  it('refuses an unknown schema version, and reads the default trees', () => {
    expect(errorsOf({ schemaVersion: 2, root: VALID.page }).map((e) => e.path)).toEqual([
      'schemaVersion',
    ])
    expect(parsed(defaultViewTree('backlog', { viewsOnly: false }))).toEqual(
      defaultViewTree('backlog', { viewsOnly: false }),
    )
    expect(parsed(defaultViewTree('home', { viewsOnly: true })).root.children).toEqual([])
  })

  it('fills config defaults', () => {
    const t = parsed(
      tree(
        { id: 'h', type: 'heading', config: { text: 'a' } },
        { id: 'tbl', type: 'table', config: { binding: { folderId: 'backlog' } } },
      ),
    )
    expect(t.root.children?.[0]).toEqual({
      id: 'h',
      type: 'heading',
      config: { text: 'a', level: 2 },
    })
    expect(t.root.children?.[1]?.config).toEqual({
      binding: { folderId: 'backlog', sort: [], limit: 50 },
    })
  })
})

describe('$me, $now and $block (D77, D79)', () => {
  it('refuses $block naming a set-bound block, or no block', () => {
    const naming = (ref: string) =>
      tree(VALID.table, {
        id: 'n',
        type: 'number',
        config: {
          kind: 'aggregate',
          binding: {
            folderId: 'backlog',
            where: { attribute: 'sprint', op: 'in', value: [{ $block: ref }] },
          },
          value: { fn: 'count' },
        },
      })
    expect(errorsOf(naming('tbl'))).toEqual([
      {
        path: 'root.children.1.config.binding.where',
        message: '$block "tbl" must name an item-bound block of this view',
      },
    ])
    expect(errorsOf(naming('nowhere')).map((e) => e.message)).toEqual([
      '$block "nowhere" must name an item-bound block of this view',
    ])
  })

  it('refuses $block inside an item binding rule', () => {
    const chained: BlockInput = {
      id: 'next',
      type: 'fields',
      config: {
        binding: {
          by: 'rule',
          folderId: 'sprints',
          where: { attribute: 'sprint', op: 'in', value: [{ $block: 'current-sprint' }] },
        },
        fields: ['title'],
      },
    }
    expect(errorsOf(tree(currentSprint, chained))).toEqual([
      {
        path: 'root.children.1.config.binding.where.value.0',
        message: '$block is allowed only in a view, outside item binding rules',
      },
    ])
  })

  it('refuses a burndown range that is not an item-bound block', () => {
    const burn = {
      ...VALID.chart,
      config: {
        ...(VALID.chart.config as object),
        range: { block: 'tbl', start: 'start', end: 'end' },
      },
    } as BlockInput
    expect(errorsOf(tree(currentSprint, VALID.table, burn)).map((e) => e.path)).toEqual([
      'root.children.2.config.range.block',
    ])
  })

  it('refuses $block outside views', () => {
    const request = aggregateRequestSchema.parse({
      from: 'backlog',
      where: inSprint,
      measures: [{ fn: 'count' }],
    })
    expect(checkAggregate(backlogAttrs, request)).toEqual([
      {
        path: 'where.value.0',
        message: '$block is allowed only in a view, outside item binding rules',
      },
    ])
    expect(checkFilterOperands(backlogAttrs, inSprint, 'where', { blocks: false })).toHaveLength(1)
  })

  it('places $me on actor lists and $now on date comparisons only', () => {
    const bad: Filter = {
      and: [
        { attribute: 'stage', op: 'in', value: [me] },
        { attribute: 'owner', op: 'in', value: me },
        { attribute: 'points', op: 'gt', value: { $now: 'P1D' } },
        { attribute: 'done-on', op: 'gt', value: { $now: 'P1M' } },
        { attribute: 'owner', op: 'in', value: [{ $me: false }] },
      ],
    }
    expect(
      checkFilterOperands(backlogAttrs, bad, 'where', { blocks: false }).map((e) => e.path),
    ).toEqual([
      'where.and.0.value.0',
      'where.and.1.value',
      'where.and.2.value',
      'where.and.3.value',
      'where.and.4.value.0',
    ])
    const good: Filter = {
      and: [
        { attribute: 'owner', op: 'not_in', value: [me, 'p2'] },
        { attribute: 'done-on', op: 'gte', value: { $now: '-P7D' } },
      ],
    }
    expect(checkFilterOperands(backlogAttrs, good, 'where', { blocks: false })).toEqual([])
  })

  it('resolves operands, and reports a $block that resolved to nothing', () => {
    const where: Filter = {
      and: [
        { attribute: 'owner', op: 'in', value: [me] },
        { attribute: 'done-on', op: 'lt', value: { $now: 'P1D' } },
        inSprint,
      ],
    }
    const now = (v: { $now: string }, includeTime: boolean) => `${v.$now}:${String(includeTime)}`
    expect(
      resolveFilterOperands(backlogAttrs, where, {
        me: 'p1',
        now,
        blocks: new Map([['current-sprint', 's24']]),
      }),
    ).toEqual({
      ok: true,
      filter: {
        and: [
          { attribute: 'owner', op: 'in', value: ['p1'] },
          { attribute: 'done-on', op: 'lt', value: 'P1D:false' },
          { attribute: 'sprint', op: 'in', value: ['s24'] },
        ],
      },
    })
    expect(
      resolveFilterOperands(backlogAttrs, where, {
        me: 'p1',
        now,
        blocks: new Map([['current-sprint', null]]),
      }),
    ).toEqual({
      ok: false,
      unresolved: ['current-sprint'],
    })
  })

  it('accepts $me and $now in POST /query, with an optional tz', () => {
    const q = itemQuerySchema.parse({
      from: 'backlog',
      where: { attribute: 'owner', op: 'in', value: [me] },
      limit: 10,
      tz: 'Europe/Berlin',
    })
    expect(q.tz).toBe('Europe/Berlin')
    expect(
      itemQuerySchema.safeParse({ from: 'backlog', limit: 10, tz: 'Europe/Berlin; DROP' }).success,
    ).toBe(false)
  })
})

describe('aggregate requests (D80)', () => {
  const parse = (body: unknown) => aggregateRequestSchema.safeParse(body)

  it('accepts a group and 5 measures with their own where', () => {
    const request = aggregateRequestSchema.parse({
      from: 'backlog',
      where: { attribute: 'owner', op: 'in', value: [me] },
      groupBy: { attribute: 'done-on', bucket: 'week' },
      measures: [
        { fn: 'count' },
        { fn: 'count', where: { attribute: 'stage', op: 'eq', value: 'done' } },
        { fn: 'sum', attribute: 'points' },
        {
          fn: 'avg',
          attribute: 'points',
          where: { attribute: 'done-on', op: 'lt', value: { $now: 'P0D' } },
        },
        { fn: 'count_empty', attribute: 'points' },
      ],
      tz: 'America/New_York',
    })
    expect(checkAggregate(backlogAttrs, request)).toEqual([])
  })

  it('refuses no measures, 6 measures, and over 40 conditions in total', () => {
    expect(parse({ from: 'backlog', measures: [] }).success).toBe(false)
    expect(
      parse({ from: 'backlog', measures: Array.from({ length: 6 }, () => ({ fn: 'count' })) })
        .success,
    ).toBe(false)
    const twenty: Filter = {
      and: Array.from({ length: 20 }, () => ({ attribute: 'points', op: 'gt', value: 1 })),
    }
    const ok = parse({ from: 'backlog', where: twenty, measures: [{ fn: 'count', where: twenty }] })
    expect(ok.success).toBe(true)
    const over = parse({
      from: 'backlog',
      where: twenty,
      measures: [
        { fn: 'count', where: twenty },
        { fn: 'count', where: { attribute: 'points', op: 'gt', value: 1 } },
      ],
    })
    expect(over.success).toBe(false)
    expect(over.error?.issues.map((i) => i.message)).toEqual([
      "At most 40 conditions across where and every measure's where",
    ])
  })

  it('refuses a non-indexed or non-groupable group, and a date without bucket', () => {
    const check = (groupBy: object) =>
      checkAggregate(
        backlogAttrs,
        aggregateRequestSchema.parse({ from: 'backlog', groupBy, measures: [{ fn: 'count' }] }),
      ).map((e) => e.message)
    expect(check({ attribute: 'notes' })).toEqual([
      'Attribute "notes" is not indexed; only indexed attributes can be grouped or summarised',
    ])
    expect(check({ attribute: 'points' })).toEqual([
      'Attribute "points" is a number attribute; group by one of select, multi_select, actor, relation, boolean, date',
    ])
    expect(check({ attribute: 'done-on' })).toEqual([
      'A date group needs a bucket: day, week or month',
    ])
    expect(check({ attribute: 'stage', bucket: 'day' })).toEqual([
      'Only a date group takes a bucket',
    ])
    expect(check({ attribute: 'gone' })).toEqual([
      'Attribute "gone" is not an attribute of this folder',
    ])
  })

  it('refuses a non-indexed measure and a summary the type does not have', () => {
    const request = aggregateRequestSchema.parse({
      from: 'backlog',
      measures: [
        { fn: 'count_not_empty', attribute: 'notes' },
        { fn: 'sum', attribute: 'stage' },
        { fn: 'earliest', attribute: 'points' },
        {
          fn: 'count_unique',
          attribute: 'stage',
          where: { attribute: 'notes', op: 'eq', value: 'x' },
        },
      ],
    })
    expect(checkAggregate(backlogAttrs, request)).toEqual([
      {
        path: 'measures.0.attribute',
        message:
          'Attribute "notes" is not indexed; only indexed attributes can be grouped or summarised',
      },
      {
        path: 'measures.1.fn',
        message:
          'sum is not a summary of select attribute "stage"; use one of count, count_empty, count_not_empty, count_unique',
      },
      {
        path: 'measures.2.fn',
        message:
          'earliest is not a summary of number attribute "points"; use one of count, count_empty, count_not_empty, sum, avg, min, max',
      },
      {
        path: 'measures.3.where',
        message:
          'Attribute "notes" is not indexed; only indexed attributes can be filtered or sorted',
      },
    ])
  })
})

describe('checkViewTree against the hub schema (D79)', () => {
  const all = parsed(
    tree(
      currentSprint,
      VALID.section,
      VALID.heading,
      VALID.text,
      VALID.table,
      VALID.list,
      VALID.board,
      VALID.number,
      VALID.chart,
    ),
  )

  it('accepts every valid block in its hub', () => {
    expect(checkViewTree(all, context)).toEqual([])
  })

  it('marks only the blocks that use a removed attribute', () => {
    const without = new Map(context.folders)
    without.set('backlog', {
      viewsOnly: false,
      attributes: backlogAttrs.filter((a) => a.id !== 'points'),
    })
    const blocks = new Set(checkViewTree(all, { folders: without }).map((e) => e.blockId))
    expect([...blocks].sort()).toEqual(['brd', 'burn', 'lst', 'num'])
  })

  it('refuses folders outside the hub or views-only, and non-indexed filters and sorts', () => {
    const t = parsed(
      tree(
        { id: 'a', type: 'table', config: { binding: { folderId: 'elsewhere' } } },
        { id: 'b', type: 'table', config: { binding: { folderId: 'home' } } },
        {
          id: 'c',
          type: 'table',
          config: {
            binding: {
              folderId: 'backlog',
              where: { attribute: 'notes', op: 'eq', value: 'x' },
              sort: [{ attribute: 'notes' }],
            },
          },
        },
        {
          id: 'd',
          type: 'fields',
          config: { binding: { by: 'item', folderId: 'sprints', itemId: 's1' }, fields: ['stage'] },
        },
      ),
    )
    expect(checkViewTree(t, context).map((e) => [e.blockId, e.path])).toEqual([
      ['a', 'root.children.0.config.binding.folderId'],
      ['b', 'root.children.1.config.binding.folderId'],
      ['c', 'root.children.2.config.binding.where'],
      ['c', 'root.children.2.config.binding.sort.0'],
      ['d', 'root.children.3.config.fields.0'],
    ])
  })

  it('refuses a board column that is not an indexed select, or an unknown option', () => {
    const board = (attribute: string, option: string) =>
      parsed(
        tree({
          id: 'b',
          type: 'board',
          config: {
            binding: { folderId: 'backlog' },
            column: { attribute, options: [{ option }] },
          },
        }),
      )
    expect(checkViewTree(board('owner', 'x'), context).map((e) => e.message)).toEqual([
      'Attribute "owner" is a actor attribute, not select',
    ])
    expect(checkViewTree(board('stage', 'gone'), context).map((e) => e.message)).toEqual([
      '"gone" is not an option of "stage"',
    ])
  })
})

describe('createPresets (D77)', () => {
  it('presets top-level AND equalities and the group value, $me resolved', () => {
    const where: Filter = {
      and: [
        { attribute: 'owner', op: 'in', value: [me] },
        { attribute: 'sprint', op: 'in', value: ['s24'] },
        { attribute: 'points', op: 'gt', value: 1 },
        { or: [{ attribute: 'stage', op: 'eq', value: 'todo' }] },
      ],
    }
    expect(
      createPresets(backlogAttrs, where, 'p1', { attribute: 'stage', value: 'review' }),
    ).toEqual({
      owner: ['p1'],
      sprint: ['s24'],
      stage: 'review',
    })
  })

  it('presets nothing from an OR (the Work board sets only Stage)', () => {
    const where: Filter = {
      or: [
        { attribute: 'owner', op: 'in', value: [me] },
        { attribute: 'owner', op: 'in', value: ['p2'] },
      ],
    }
    expect(createPresets(backlogAttrs, where, 'p1', { attribute: 'stage', value: 'todo' })).toEqual(
      { stage: 'todo' },
    )
    expect(createPresets(backlogAttrs, undefined, 'p1')).toEqual({})
  })
})

describe('view data and folder contracts (D76, D83)', () => {
  it('parses the query string', () => {
    expect(viewDataQuerySchema.parse({ version: '3', blocks: 'a,b', tz: 'UTC' })).toEqual({
      version: 3,
      blocks: ['a', 'b'],
      tz: 'UTC',
    })
    expect(viewDataQuerySchema.safeParse({ version: '-1' }).success).toBe(false)
    expect(viewDataQuerySchema.safeParse({ version: '1', blocks: 'a,,b' }).success).toBe(false)
  })

  it('carries a status per block', () => {
    const body = {
      folderId: 'home',
      version: 2,
      seq: 10,
      blocks: {
        num: {
          status: 'ok',
          data: {
            kind: 'aggregate',
            groups: [{ key: { kind: 'all' }, values: [16, 34] }],
            truncated: false,
          },
        },
        burn: { status: 'unresolved', blocks: ['current-sprint'] },
        lst: {
          status: 'invalid',
          errors: [{ path: 'root.children.0.config.fields.0', message: 'gone' }],
        },
        fix: { status: 'not_found' },
        brd: { status: 'error', error: 'timeout' },
        grp: {
          status: 'ok',
          data: {
            kind: 'aggregate',
            truncated: true,
            groups: [
              { key: { kind: 'value', value: 'p1' }, values: [3] },
              { key: { kind: 'no_access' }, values: [2] },
              { key: { kind: 'other' }, values: [1] },
            ],
          },
        },
      },
    }
    expect(viewDataSchema.parse(body)).toEqual(body)
    expect(viewDataSchema.safeParse({ ...body, blocks: { x: { status: 'stale' } } }).success).toBe(
      false,
    )
  })

  it('marks views-only folders and the hub opens-on folder only when set', () => {
    const folder = {
      workspaceId: 'w',
      id: 'home',
      hubId: 'h',
      parentId: 'h',
      name: 'Home',
      color: 'blue',
      idPrefix: 'PT',
      itemCount: 0,
      version: 0,
    }
    expect(folderSchema.parse(folder)).toEqual(folder)
    expect(folderSchema.parse({ ...folder, viewsOnly: true }).viewsOnly).toBe(true)
    expect(folderSchema.safeParse({ ...folder, viewsOnly: false }).success).toBe(false)
    expect(
      createFolderSchema.parse({ parentId: 'h', name: 'Home', color: 'blue', viewsOnly: true })
        .viewsOnly,
    ).toBe(true)
    const hub = { ...folder, id: 'h', parentId: null, titleAttributeId: null }
    expect(hubSchema.parse({ ...hub, opensOnFolderId: 'home' }).opensOnFolderId).toBe('home')
    expect(updateHubSchema.parse({ version: 1, opensOnFolderId: null })).toEqual({
      version: 1,
      opensOnFolderId: null,
    })
  })
})
