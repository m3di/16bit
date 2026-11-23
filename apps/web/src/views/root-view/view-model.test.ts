import { parseViewTree, type Block } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import { fakeApi, json } from '../hub/fixtures.test-utils.ts'
import { description, homeData, homeTree, page, rawView } from './fixtures.test-utils.ts'
import {
  dataBlocks,
  msUntilMidnight,
  readsToday,
  shownItemIds,
  staleBlocks,
  watches,
} from './refresh.ts'
import { headingLevel, readableBlocks, readTree } from './render-tree.ts'
import { defaultViewSource, httpViewSource, viewDataQuery } from './source.ts'
import { stateOf } from './registry.ts'

const homeBlocks = (): Block[] => {
  const parsed = parseViewTree(homeTree)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return readableBlocks(readTree(parsed.tree).page)
}

describe('view sources', () => {
  it('asks the view-data route with the version, a block subset and the zone', () => {
    expect(viewDataQuery({ version: 3 })).toBe('version=3')
    expect(viewDataQuery({ version: 3, blocks: ['a', 'b'], tz: 'Europe/Berlin' })).toBe(
      'version=3&blocks=a%2Cb&tz=Europe%2FBerlin',
    )
  })

  it('reads a view and keeps its tree as sent, for the renderer to check', async () => {
    const api = fakeApi(({ path }) =>
      path.endsWith('/view')
        ? json(rawView('home', { schemaVersion: 99, root: { id: 'p' } }))
        : json(homeData()),
    )
    const source = httpViewSource('w', api.fetchFn)
    const view = await source.view('home')
    expect(view.tree).toEqual({ schemaVersion: 99, root: { id: 'p' } })
    expect(api.calls[0]?.path).toBe('/v1/workspaces/w/folders/home/view')
    const data = await source.data('home', { version: 3, tz: 'UTC' })
    expect(data.seq).toBe(41)
    expect(api.calls[1]?.path).toBe('/v1/workspaces/w/folders/home/view/data?version=3&tz=UTC')
  })

  it('passes the route’s errors on as request errors (409 stale, 429)', async () => {
    const api = fakeApi(() => json({ error: 'stale', message: 'The view changed.' }, 409))
    const source = httpViewSource('w', api.fetchFn)
    await expect(source.data('home', { version: 1 })).rejects.toBeInstanceOf(ApiRequestError)
    await expect(source.data('home', { version: 1 })).rejects.toMatchObject({ code: 'stale' })
  })

  it('answers each folder’s default at once until the routes exist', () => {
    const source = defaultViewSource(() => description)
    const bugs = source.view('b')
    const home = source.view('home')
    if (bugs instanceof Promise || home instanceof Promise) throw new Error('not at once')
    expect(bugs).toMatchObject({ stored: false, version: 0 })
    expect(readTree(bugs.tree).tree?.root.children?.[0]?.type).toBe('table')
    expect(readTree(home.tree).tree?.root.children).toEqual([])
  })
})

describe('reading a tree for the renderer', () => {
  it('maps a tree that reads in full one to one', () => {
    const read = readTree(homeTree)
    expect(read.tree).not.toBeNull()
    expect(read.page?.children.map((c) => (c.kind === 'block' ? c.block.type : 'broken'))).toEqual([
      'text',
      'heading',
      'fields',
      'section',
      'columns',
      'board',
    ])
  })

  it('reads block by block when one block is from a newer build, so the rest still renders', () => {
    const raw = page([
      { id: 'a', type: 'text', config: { text: 'Kept' } },
      { id: 'b', type: 'timeline', config: {} } as never,
      { id: 'c', type: 'heading', config: { text: '' } },
      {
        id: 's',
        type: 'section',
        config: {},
        children: [{ id: 'd', type: 'text', config: { text: 'Nested' } }],
      },
    ])
    const read = readTree(raw)
    expect(read.tree).toBeNull()
    expect(read.page?.children.map((c) => c.kind)).toEqual(['block', 'broken', 'broken', 'block'])
    expect(readableBlocks(read.page).map((b) => b.id)).toEqual(['page', 'a', 's', 'd'])
  })

  it('has no page when even the root cannot be read', () => {
    expect(readTree(null).page).toBeNull()
    expect(
      readTree({ schemaVersion: 1, root: { id: 'x', type: 'text', config: {} } }).page,
    ).toBeNull()
  })

  it('keeps one h1 and never skips a heading level', () => {
    // Under the page (outline 1): every heading is an h2.
    expect([1, 2, 3].map((l) => headingLevel(l as 1 | 2 | 3, 1))).toEqual([2, 2, 2])
    // In a titled section (outline 2): h2 or h3.
    expect([1, 2, 3].map((l) => headingLevel(l as 1 | 2 | 3, 2))).toEqual([2, 2, 3])
  })
})

describe('when blocks are stale (D83)', () => {
  it('lists the data blocks in order', () => {
    expect(dataBlocks(homeBlocks()).map((b) => b.id)).toEqual([
      'sprint',
      'backlog',
      'open',
      'day',
      'in-sprint',
    ])
  })

  it('watches the bound folder, the folders `$block` names, and relation target hubs shown', () => {
    const blocks = [
      ...homeBlocks(),
      {
        id: 'epics',
        type: 'list',
        config: {
          binding: { folderId: 'b', sort: [], limit: 50 },
          fields: [{ attribute: 'rel' }],
          create: false,
        },
      } satisfies Block,
    ]
    const withRelation = {
      ...description,
      attributes: [
        ...description.attributes,
        {
          ...description.attributes[0],
          id: 'rel',
          type: 'relation',
          config: { targetHubId: 'epics-hub', crossHub: true, multiple: true },
        } as (typeof description.attributes)[number],
      ],
    }
    const w = watches(blocks, withRelation)
    expect([...(w.get('in-sprint')?.folders ?? [])]).toEqual(['bld', 'sp'])
    expect([...(w.get('epics')?.hubs ?? [])]).toEqual(['epics-hub'])
    const touched = staleBlocks(
      { seq: 1, hubId: 'epics-hub', itemId: 'e1', item: null },
      new Map([['epics', w.get('epics') ?? { folders: new Set(), hubs: new Set() }]]),
      () => [],
    )
    expect(touched).toEqual(['epics'])
  })

  it('knows which items a block shows', () => {
    expect(shownItemIds(homeData().blocks['backlog'])).toEqual(['i1'])
    expect(shownItemIds(homeData().blocks['sprint'])).toEqual(['s1'])
    expect(shownItemIds({ status: 'not_found' })).toEqual([])
  })

  it('moves day counts, burndowns and `$now` filters on at midnight', () => {
    const [sprint, , open, day] = dataBlocks(homeBlocks())
    expect(day && readsToday(day)).toBe(true)
    expect(open && readsToday(open)).toBe(false)
    expect(sprint && readsToday(sprint)).toBe(false)
    const parsed = parseViewTree(
      page([
        {
          id: 'due',
          type: 'list',
          config: {
            binding: {
              folderId: 'b',
              where: { attribute: 'due', op: 'lt', value: { $now: 'P0D' } },
            },
          },
        },
      ]),
    )
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
    const [due] = dataBlocks(readableBlocks(readTree(parsed.tree).page))
    expect(due && readsToday(due)).toBe(true)
  })

  it('counts to midnight in the reader’s zone', () => {
    const at = new Date(Date.UTC(2026, 10, 23, 22, 30, 0))
    expect(msUntilMidnight(at, 'UTC')).toBe(90 * 60_000)
    // 23:30 in Berlin (UTC+1 in November).
    expect(msUntilMidnight(at, 'Europe/Berlin')).toBe(30 * 60_000)
    // UTC when the zone is unknown to the runtime would be wrong; a day keeps the timer sane.
    expect(msUntilMidnight(at, 'Not/AZone')).toBe(86_400_000)
  })
})

describe('block states', () => {
  it('maps each answer to a block state', () => {
    expect(stateOf(undefined)).toBe('loading')
    expect(stateOf({ state: 'failed' })).toBe('error')
    expect(stateOf({ state: 'ready', status: { status: 'not_found' } })).toBe('not-found')
    expect(stateOf({ state: 'ready', status: { status: 'unresolved', blocks: ['s'] } })).toBe(
      'unresolved',
    )
    expect(stateOf({ state: 'ready', status: { status: 'invalid', errors: [] } })).toBe('invalid')
    expect(stateOf({ state: 'ready', status: { status: 'error', error: 'timeout' } })).toBe('error')
    expect(
      stateOf({ state: 'ready', status: homeData().blocks['open'] ?? { status: 'not_found' } }),
    ).toBe('ready')
  })
})
