import type { Attribute, HubDescription } from '@16bit/core'
import { createMemoryHistory } from 'vue-router'
import { describe, expect, it } from 'vitest'
import { makeRouter } from '../../router.ts'
import { ApiRequestError } from '../../api/client.ts'
import { description, fakeApi, item, json } from '../hub/fixtures.test-utils.ts'
import { folderColumns } from '../hub/useHub.ts'
import {
  expandFor,
  folderLink,
  hiddenNote,
  itemFolder,
  afterExpandRead,
  itemPageLink,
  malformedItemId,
  pageState,
  pageTitle,
} from './item-page.ts'
import { useBacklinks } from './useBacklinks.ts'

const titled: HubDescription = {
  ...description,
  hub: { ...description.hub, titleAttributeId: 'title' },
}

describe('pageTitle (D50)', () => {
  it("is the value of the hub's title attribute, trimmed", () => {
    expect(pageTitle(item('i1', 1, { title: '  Ship it ' }), titled)).toBe('Ship it')
  })

  it('is empty without a title attribute, even if a text attribute has a value', () => {
    expect(pageTitle(item('i1', 1, { title: 'Ship it' }), description)).toBe('')
  })

  it('is empty for an empty or missing value', () => {
    expect(pageTitle(item('i1', 1, { title: '   ' }), titled)).toBe('')
    expect(pageTitle(item('i1', 1, {}), titled)).toBe('')
  })
})

describe('expandFor', () => {
  const relation = (id: string, position: number) => ({
    attribute: {
      ...(description.attributes[0] as Attribute),
      id,
      type: 'relation',
      config: { targetHubId: 'bld', crossHub: false, multiple: true },
    } as Attribute,
    required: false,
    position,
  })

  it('expands relation attributes only, at most three, in position order', () => {
    const columns = [
      ...folderColumns(description, 'bld'),
      relation('r1', 3),
      relation('r2', 4),
      relation('r3', 5),
      relation('r4', 6),
    ]
    expect(expandFor(columns)).toEqual(['r1', 'r2', 'r3'])
    expect(expandFor(folderColumns(description, 'bld'))).toEqual([])
  })
})

describe('links and folders', () => {
  it('finds the folder of an item, the hub itself included', () => {
    expect(itemFolder(description, item('i1', 1))?.name).toBe('Build')
    expect(itemFolder(description, { ...item('i1', 1), folderId: 'b' })?.name).toBe('Bugs')
    expect(itemFolder(description, { ...item('i1', 1), folderId: 'zz' })).toBeNull()
  })

  it("links to the item's page and to its folder", () => {
    expect(itemPageLink('w', { id: 'i1' })).toEqual({
      name: 'item',
      params: { workspaceId: 'w', itemId: 'i1' },
    })
    expect(folderLink('w', item('i1', 1))).toEqual({
      name: 'hub',
      params: { workspaceId: 'w', hubId: 'bld' },
    })
    expect(folderLink('w', { ...item('i1', 1), folderId: 'b' })).toEqual({
      name: 'hub',
      params: { workspaceId: 'w', hubId: 'bld', folderId: 'b' },
    })
  })
})

describe('hiddenNote', () => {
  it('counts links from items the reader cannot see, and says when the count is capped', () => {
    expect(hiddenNote(0)).toBe('')
    expect(hiddenNote(1)).toBe('1 link from an item you cannot see.')
    expect(hiddenNote(4)).toBe('4 links from items you cannot see.')
    expect(hiddenNote(1000)).toBe('1,000 or more links from items you cannot see.')
  })
})

describe('pageState', () => {
  const err = (status: number) => ({
    state: 'error' as const,
    error: new ApiRequestError(status === 404 ? 'not_found' : 'forbidden', 'x', status),
  })
  const ready = { state: 'ready' as const, data: item('i1', 1) }

  it('maps a 404 to not found, a 403 to no permission, anything else to error', () => {
    expect(pageState(err(404), null).state).toBe('not-found')
    expect(pageState(err(403), null).state).toBe('no-permission')
    expect(pageState(err(500), null).state).toBe('error')
  })

  it('waits for the hub, and is an error if the hub cannot be read', () => {
    expect(pageState({ state: 'loading' }, null).state).toBe('loading')
    expect(pageState(ready, null).state).toBe('loading')
    expect(pageState(ready, { state: 'loading' }).state).toBe('loading')
    expect(pageState(ready, err(404)).state).toBe('error')
    expect(pageState(ready, { state: 'ready', data: description })).toEqual({
      state: 'ready',
      item: ready.data,
      hub: description,
    })
  })
})

describe('malformedItemId (#145)', () => {
  it('is not found, with no retry, for an ID the API would refuse', () => {
    for (const id of ['has space', 'a/b', '', 'x'.repeat(65), 'é']) {
      const load = malformedItemId(id)
      expect(load).toMatchObject({ state: 'error', error: { status: 404 } })
      expect(pageState(load ?? { state: 'loading' }, null).state).toBe('not-found')
    }
  })

  it('lets a well-formed ID through to the API', () => {
    expect(malformedItemId('i1')).toBeNull()
    expect(malformedItemId('0b8f_A-9')).toBeNull()
  })
})

describe('afterExpandRead (#145)', () => {
  const first = { state: 'ready' as const, data: item('i1', 1) }
  const failed = (status: number) => ({
    state: 'error' as const,
    error: new ApiRequestError(status === 404 ? 'not_found' : 'internal', 'x', status),
  })

  it('shows not found or no permission when the item went away between the reads', () => {
    expect(pageState(afterExpandRead(first, failed(404)), null).state).toBe('not-found')
    expect(pageState(afterExpandRead(first, failed(403)), null).state).toBe('no-permission')
  })

  it('keeps the first copy when the second read works or fails for another reason', () => {
    expect(afterExpandRead(first, { state: 'ready', data: item('i1', 2) })).toBe(first)
    expect(afterExpandRead(first, failed(500))).toBe(first)
    expect(afterExpandRead(first, failed(0))).toBe(first)
  })
})

describe('useBacklinks', () => {
  const entry = (id: string, attributeId = 'blocks') => ({ attributeId, item: item(id, 2) })

  it('reads the first page with the hidden count', async () => {
    const api = fakeApi(() => json({ items: [entry('a')], nextCursor: null, hidden: 2 }))
    const b = useBacklinks('w', 'i1', api.fetchFn)
    await b.load()
    expect(api.calls[0]?.path).toBe('/v1/workspaces/w/items/i1/backlinks?limit=50')
    expect(b.list.value).toMatchObject({ state: 'ready', data: { hidden: 2, nextCursor: null } })
  })

  it('loads more with the cursor and skips entries it already has', async () => {
    const api = fakeApi((call) =>
      call.path.includes('cursor=c1')
        ? json({ items: [entry('b'), entry('c')], nextCursor: null, hidden: 0 })
        : json({ items: [entry('a'), entry('b')], nextCursor: 'c1', hidden: 0 }),
    )
    const b = useBacklinks('w', 'i1', api.fetchFn)
    await b.load()
    await b.loadMore()
    const list = b.list.value
    expect(list.state === 'ready' && list.data.entries.map((e) => e.item.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('keeps the entries and shows the error when more cannot be loaded', async () => {
    const api = fakeApi((call) =>
      call.path.includes('cursor=c1')
        ? json({ error: 'internal', message: 'Down' }, 500)
        : json({ items: [entry('a')], nextCursor: 'c1', hidden: 0 }),
    )
    const b = useBacklinks('w', 'i1', api.fetchFn)
    await b.load()
    await b.loadMore()
    expect(b.list.value).toMatchObject({
      state: 'ready',
      data: { nextCursor: 'c1', more: false, moreError: { message: 'Down' } },
    })
  })

  it('shows an error state when the first page fails', async () => {
    const api = fakeApi(() => json({ error: 'internal', message: 'Down' }, 500))
    const b = useBacklinks('w', 'i1', api.fetchFn)
    await b.load()
    expect(b.list.value).toMatchObject({ state: 'error', error: { status: 500 } })
  })
})

describe('item route', () => {
  it('opens an item by ID beside the hub and settings routes', () => {
    const router = makeRouter(createMemoryHistory())
    const to = router.resolve('/w/w1/items/i1')
    expect(to.name).toBe('item')
    expect(to.params).toEqual({ workspaceId: 'w1', itemId: 'i1' })
    expect(router.resolve(itemPageLink('w1', { id: 'i1' })).fullPath).toBe('/w/w1/items/i1')
    expect(router.resolve('/w/w1/settings/members').name).toBe('workspace-members')
  })
})
