import { createSSRApp, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import BarRows from './BarRows.vue'
import BlockColumns from './BlockColumns.vue'
import BlockSection from './BlockSection.vue'
import BoardColumn from './BoardColumn.vue'
import BoardView from './BoardView.vue'
import BoardCard from './BoardCard.vue'
import FieldsInline from './FieldsInline.vue'
import GroupedList from './GroupedList.vue'
import NoViewYet from './NoViewYet.vue'
import NumberStat from './NumberStat.vue'
import PageHeader from './PageHeader.vue'
import StateBlock from './StateBlock.vue'
import {
  BLOCK_STATE_TEXT,
  SHORT_STATE_TEXT,
  barPercent,
  countLabel,
  fieldWidth,
  joinFields,
  measureText,
  moreText,
  splitFields,
  type ListField,
  type ListGroup,
} from './blocks.ts'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:p(.*)*', component: { render: () => null } }],
})

const render = (
  c: Component,
  props: Record<string, unknown> = {},
  slots?: Record<string, () => unknown>,
) => {
  const app = createSSRApp({ render: () => h(c, props, slots) })
  app.use(router)
  return renderToString(app)
}

const STATES = [
  'loading',
  'empty',
  'error',
  'no-permission',
  'not-found',
  'invalid',
  'unresolved',
] as const

describe('block helpers', () => {
  it.each([
    [11, 12, 91.7],
    [0, 10, 0],
    [12, 10, 100],
    [-3, 10, 0],
    [5, 0, 0],
    [Number.NaN, 10, 0],
  ])('barPercent(%d, %d) is %d', (value, max, expected) => {
    expect(barPercent(value, max)).toBe(expected)
  })

  it('measureText joins at most two measures and skips blanks', () => {
    expect(measureText(['19 points'])).toBe('19 points')
    expect(measureText(['13 points', '', '1 not estimated', '3 bugs'])).toBe(
      '13 points, 1 not estimated',
    )
    expect(measureText(undefined)).toBe('')
  })

  it('splitFields keeps 4 fields and puts lead fields before the title', () => {
    const fields: ListField[] = [
      { key: 'id', label: 'ID', lead: true },
      { key: 'type', label: 'Type' },
      { key: 'epic', label: 'Epic' },
      { key: 'points', label: 'Points', align: 'end' },
      { key: 'owner', label: 'Owner' },
    ]
    const { lead, rest } = splitFields(fields)
    expect(lead.map((f) => f.key)).toEqual(['id'])
    expect(rest.map((f) => f.key)).toEqual(['type', 'epic', 'points'])
  })

  it('fieldWidth follows the backlog mockup unless a width is given', () => {
    expect(fieldWidth({ key: 'id', label: 'ID', lead: true })).toBe(52)
    expect(fieldWidth({ key: 'p', label: 'Points', align: 'end' })).toBe(24)
    expect(fieldWidth({ key: 'e', label: 'Epic' })).toBe(110)
    expect(fieldWidth({ key: 'e', label: 'Epic', width: 80 })).toBe(80)
  })

  it('joinFields keeps empty text and drops missing values', () => {
    expect(
      joinFields([{ text: 'In progress' }, undefined, { text: 'No owner', empty: true }]),
    ).toBe('In progress, No owner')
  })

  it('moreText and countLabel', () => {
    expect(moreText(0)).toBe('')
    expect(moreText(undefined)).toBe('')
    expect(moreText(1200)).toBe('+1,200 more')
    expect(countLabel(1)).toBe('1 item')
    expect(countLabel(0)).toBe('0 items')
  })

  it('every state has short and block text, and none says the thing does not exist', () => {
    for (const s of STATES) {
      expect(SHORT_STATE_TEXT[s]).toBeTruthy()
      expect(BLOCK_STATE_TEXT[s].title).toBeTruthy()
      expect(BLOCK_STATE_TEXT[s].message).not.toMatch(/does not exist/i)
    }
  })
})

describe('block components', () => {
  it.each(STATES.filter((s) => s !== 'loading'))(
    'StateBlock draws a distinct glyph for %s, in both sizes',
    async (state) => {
      const glyph = (html: string) => /<span aria-hidden="true" class="([^"]+)"/.exec(html)?.[1]
      const mine = glyph(await render(StateBlock, { state, compact: true }))
      for (const other of STATES.filter((s) => s !== state && s !== 'loading')) {
        expect(glyph(await render(StateBlock, { state: other, compact: true }))).not.toBe(mine)
      }
      expect(await render(StateBlock, { state })).toContain(`data-state="${state}"`)
    },
  )

  it('invalid and unresolved are never alerts; error is one only at full size', async () => {
    expect(await render(StateBlock, { state: 'invalid', compact: true })).not.toContain(
      'role="alert"',
    )
    expect(await render(StateBlock, { state: 'unresolved' })).not.toContain('role="alert"')
    expect(await render(StateBlock, { state: 'error' })).toContain('role="alert"')
    // Up to 20 blocks share a page (D77): the renderer announces one page-level message.
    expect(await render(StateBlock, { state: 'error', compact: true })).not.toContain('role=')
    expect(await render(NumberStat, { label: 'x', state: 'error' })).not.toContain('role=')
  })

  it('compact loading is busy but not a live region; full size is a status', async () => {
    const compact = await render(StateBlock, { state: 'loading', compact: true })
    expect(compact).toContain('aria-busy="true"')
    expect(compact).toContain('<span class="sr-only">Loading</span>')
    expect(compact).not.toContain('role=')
    expect(await render(StateBlock, { state: 'loading' })).toContain('role="status"')
    for (const [c, props] of [
      [GroupedList, { groups: [], fields: [] }],
      [BarRows, { rows: [] }],
      [BoardView, { columns: [] }],
      [FieldsInline, { fields: [] }],
    ] as const) {
      expect(await render(c, { ...props, state: 'loading' })).not.toContain('role=')
    }
  })

  it('PageHeader is the page h1 with the live dot as a status', async () => {
    const html = await render(PageHeader, { title: 'Parcel Tracker v2', live: 'online' })
    expect(html).toMatch(/<h1[^>]*>\s*Parcel Tracker v2\s*<\/h1>/)
    // Live is shown, not announced: the status region is empty while online or connecting.
    const region = (h: string) =>
      /<span role="status"[^>]*data-live-region>([\s\S]*?)<\/span>/.exec(h)?.[1]
    expect(html).toContain('Live')
    expect(region(html)).toBe('<!---->')
    expect(region(await render(PageHeader, { title: 'x', live: 'connecting' }))).toBe('<!---->')
    const offline = await render(PageHeader, { title: 'x', live: 'offline' })
    expect(offline).toContain('Offline')
    expect(offline).toMatch(/data-live-region><span class="sr-only">Live updates are paused/)
    expect(await render(PageHeader, { title: 'x', live: 'stopped' })).toMatch(
      /data-live-region><span[^>]*>Live updates stopped/,
    )
    expect(await render(PageHeader, { title: 'x' })).not.toContain('data-live')
    const loading = await render(PageHeader, { title: '', loading: true })
    expect(loading).not.toContain('<h1')
    expect(loading).toContain('aria-busy="true"')
  })

  it('BlockSection names its section by its h2 and keeps the caption', async () => {
    const html = await render(BlockSection, {
      title: 'Current work',
      caption: 'Sprint 24, by stage',
    })
    const id = /<h2 id="([^"]+)"/.exec(html)?.[1]
    expect(html).toContain(`aria-labelledby="${String(id)}"`)
    expect(html).toContain('Sprint 24, by stage')
  })

  it('BlockColumns wraps each child and shares the width by weight', async () => {
    const html = await render(
      BlockColumns,
      { weights: [3, 2], min: 300 },
      {
        default: () => [h('p', 'a'), null, [h('p', 'b')]],
      },
    )
    expect(html).toContain('flex:3 1 300px')
    expect(html).toContain('flex:2 1 300px')
    expect(html.match(/class="min-w-0"/g)).toHaveLength(2)
  })

  it('NumberStat shows "16 of 34" and keeps its label in every state', async () => {
    const html = await render(NumberStat, { label: 'Points done', value: 16, of: 34 })
    expect(html).toContain('16')
    expect(html).toContain('of 34')
    for (const state of STATES) {
      const s = await render(NumberStat, { label: 'Points done', state })
      expect(s).toContain('Points done')
      expect(s).toContain(SHORT_STATE_TEXT[state])
    }
    expect(
      await render(NumberStat, { label: 'x', state: 'unresolved', stateText: 'No current sprint' }),
    ).toContain('No current sprint')
  })

  const backlogFields: ListField[] = [
    { key: 'id', label: 'ID', lead: true },
    { key: 'type', label: 'Type' },
    { key: 'epic', label: 'Epic' },
    { key: 'points', label: 'Points', align: 'end' },
  ]
  const backlog: ListGroup[] = [
    {
      id: 'next',
      label: 'Next up',
      measures: ['19 points', '1 not estimated', 'ignored'],
      rows: [
        {
          id: 'r1',
          title: 'Retry failed webhooks',
          values: {
            id: { text: 'PT-225' },
            type: { text: 'Bug', color: 'red' },
            epic: { text: 'No epic', empty: true },
            points: { text: '3' },
          },
        },
      ],
      more: 3,
    },
  ]

  it('GroupedList puts the ID before the title in mono, labels fields, and shows measures', async () => {
    const html = await render(GroupedList, { groups: backlog, fields: backlogFields })
    expect(html).toMatch(/<h3 id="([^"]+)"[^>]*>[\s\S]*Next up[\s\S]*19 points, 1 not estimated/)
    expect(html).not.toContain('ignored')
    expect(html.indexOf('PT-225')).toBeLessThan(html.indexOf('Retry failed webhooks'))
    expect(html).toMatch(/font-mono[^"]*"[^>]*>[\s\S]*?PT-225/)
    expect(html).toContain('<span class="sr-only">, Type </span><span')
    expect(html).toContain('data-empty')
    expect(html).toContain('var(--pal-red)')
    expect(html).toContain('+3 more')
    expect(html).toMatch(/<button type="button"[^>]*>/)
  })

  it('GroupedList rows with a route are links', async () => {
    const groups = backlog.map((g) => ({
      ...g,
      rows: g.rows.map((r) => ({ ...r, to: '/w/x/items/r1' })),
    }))
    const html = await render(GroupedList, { groups, fields: backlogFields })
    expect(html).toContain('href="/w/x/items/r1"')
  })

  it('GroupedList summary joins fields after a dot', async () => {
    const html = await render(GroupedList, {
      variant: 'summary',
      fields: [
        { key: 'stage', label: 'Stage' },
        { key: 'owner', label: 'Owner' },
      ],
      groups: [
        {
          id: 'all',
          label: '',
          rows: [
            {
              id: 'r',
              title: 'Delivery window picker',
              values: { stage: { text: 'In progress', color: 'amber' }, owner: { text: 'Sara' } },
            },
          ],
        },
      ],
    })
    expect(html).toContain('In progress, Sara')
    expect(html).toContain('var(--pal-amber)')
    expect(html).not.toContain('<h3')
  })

  it.each(STATES)(
    'GroupedList, BarRows, BoardView and FieldsInline render %s in place',
    async (state) => {
      for (const [c, props] of [
        [GroupedList, { groups: backlog, fields: backlogFields }],
        [BarRows, { rows: [] }],
        [BoardView, { columns: [] }],
        [FieldsInline, { fields: [] }],
      ] as const) {
        const html = await render(c, { ...props, state })
        expect(html).toContain(state === 'loading' ? 'aria-busy="true"' : `data-state="${state}"`)
        expect(html).not.toContain('data-block=')
      }
    },
  )

  it('an empty list says so; an empty group inside a list shows its empty text', async () => {
    expect(
      await render(GroupedList, { groups: [], fields: [], emptyText: 'Nothing in this sprint' }),
    ).toContain('Nothing in this sprint')
    const html = await render(GroupedList, {
      groups: [...backlog, { id: 'ice', label: 'Icebox', rows: [] }],
      fields: backlogFields,
      emptyText: 'Nothing in this group.',
    })
    expect(html).toContain('data-group-empty')
  })

  it('GroupedList and BoardColumn name their create button by group', async () => {
    const list = await render(GroupedList, {
      groups: backlog,
      fields: backlogFields,
      creatable: true,
    })
    expect(list).toContain('New item<span class="sr-only"> in Next up</span>')
    const column = await render(BoardColumn, {
      label: 'In review',
      count: 0,
      cards: [],
      creatable: true,
    })
    expect(column).toContain('New item<span class="sr-only"> in In review</span>')
  })

  it('BoardColumn shows its empty text in a dashed box and its count for screen readers', async () => {
    const html = await render(BoardColumn, {
      label: 'In review',
      color: 'blue',
      count: 0,
      cards: [],
      emptyText: 'Nothing of yours is in review.',
    })
    expect(html).toMatch(/border-dashed[^>]*>\s*Nothing of yours is in review\./)
    expect(html).toContain(', 0 items')
    expect(html).toContain('var(--pal-blue)')
  })

  it('BoardColumn with a count but no cards says how many, not its empty text', async () => {
    const html = await render(BoardColumn, {
      label: 'In QA',
      count: 3,
      cards: [],
      emptyText: 'None',
    })
    expect(html).toContain('+3 more')
    expect(html).not.toContain('data-column-empty')
  })

  it('GroupedList reads no field name for a field with no value', async () => {
    const groups: ListGroup[] = [
      { id: 'g', label: '', rows: [{ id: 'r', title: 'T', values: { id: { text: 'PT-1' } } }] },
    ]
    const html = await render(GroupedList, { groups, fields: backlogFields })
    expect(html).toContain('ID ')
    expect(html).not.toContain(', Epic')
  })

  it('BoardColumn says how many cards are not shown', async () => {
    const html = await render(BoardColumn, {
      label: 'In QA',
      count: 27,
      cards: [{ id: 'c', title: 'Push', fields: [] }],
    })
    expect(html).toContain('+26 more')
  })

  it('BoardCard joins up to 4 fields with commas', async () => {
    const html = await render(BoardCard, {
      title: 'Delivery window picker',
      fields: [
        { text: 'PT-214', mono: true },
        { text: '5 points' },
        { text: 'a' },
        { text: 'b' },
        { text: 'e' },
      ],
    })
    expect(html).toMatch(/^<button type="button"/)
    expect(html).toContain('PT-214')
    expect(html).toContain(', ')
    expect(html).not.toMatch(/>e</)
  })

  it('BarRows always says the value in text; the bar is hidden', async () => {
    const html = await render(BarRows, {
      rows: [{ id: 'e', label: 'Courier tools', value: 11, max: 12, text: '11 of 12' }],
    })
    expect(html).toContain('11 of 12')
    expect(html).toMatch(/aria-hidden="true" class="block h-1 bg-line"/)
    expect(html).toContain('width:91.7%')
    const inline = await render(BarRows, {
      layout: 'inline',
      rows: [
        {
          id: 'q',
          label: 'qa-agent',
          actor: { id: 'qa', name: 'qa-agent', kind: 'agent' },
          value: 2,
          max: 10,
          text: '2',
        },
      ],
    })
    expect(inline).toContain('Agent')
  })

  it('FieldsInline is a description list, inline or stacked', async () => {
    const fields = [{ key: 's', label: 'Start', value: { text: 'Nov 9' } }]
    const inline = await render(FieldsInline, { fields })
    expect(inline).toMatch(/<dl[^>]*data-layout="inline"/)
    expect(inline).toMatch(/<dt[^>]*>Start<\/dt>/)
    expect(await render(FieldsInline, { fields, stacked: true })).toContain('data-layout="stacked"')
  })

  it('NoViewYet offers Compose only when given a place to compose', async () => {
    const admin = await render(NoViewYet, { composeTo: '/settings/views' })
    expect(admin).toContain('No view yet')
    expect(admin).toMatch(/<a [^>]*href="\/settings\/views"[^>]*>Compose<\/a>/)
    const reader = await render(NoViewYet)
    expect(reader).not.toContain('Compose')
    expect(reader).toContain('A hub admin can add one.')
    expect(reader).not.toContain('role="alert"')
  })
})
