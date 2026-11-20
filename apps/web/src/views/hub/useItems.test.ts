import type { Attribute, Item } from '@16bit/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { attributes, fakeApi, item, json, type Call } from './fixtures.test-utils.ts'
import { ApiRequestError } from '../../api/client.ts'
import { resetWorkspaceStores } from '../../sync/store.ts'
import {
  canSort,
  inHub,
  LINKED_READ_LIMIT,
  newItemId,
  nextSort,
  refusedSort,
  useItems,
  valueErrors,
  withoutSeq,
} from './useItems.ts'

// The store is one per workspace and tab; every test starts with an empty one.
beforeEach(resetWorkspaceStores)

const page = (items: Item[], nextCursor: string | null = null) => json({ items, nextCursor })

/** A promise that resolves when `release` is called, to hold a request open. */
function gate<T>() {
  let release: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function opened(handler: (call: Call) => Response | Promise<Response>, items: Item[]) {
  const api = fakeApi((call) => (call.path.endsWith('/query') ? page(items) : handler(call)))
  const s = useItems('w', () => 'BLD', api.fetchFn)
  await s.openFolder('bld')
  return { s, calls: api.calls }
}

describe('useItems: reading', () => {
  it('queries the folder and keeps the server order', async () => {
    const { s, calls } = await opened(() => json({}), [item('i2', 2), item('i1', 1)])
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/workspaces/w/query',
      body: { from: 'bld', limit: 50, cursor: null, expand: [], sort: [] },
    })
    expect(s.rows.value.map((r) => r.id)).toEqual(['i2', 'i1'])
  })

  it('loads more with the cursor and skips duplicates', async () => {
    const api = fakeApi((call) => {
      const body = call.body as { cursor: string | null }
      return body.cursor === 'c1'
        ? page([item('i2', 2), item('i3', 3)])
        : page([item('i1', 1), item('i2', 2)], 'c1')
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    await s.loadMore()
    expect(s.rows.value.map((r) => r.id)).toEqual(['i1', 'i2', 'i3'])
    expect(s.list.value).toMatchObject({ state: 'ready', data: { nextCursor: null } })
  })

  it('shows an error state, and no permission for a refused key', async () => {
    const api = fakeApi(() => json({ error: 'unauthorized', message: 'No' }, 401))
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    expect(s.list.value).toMatchObject({ state: 'error', error: { isNoPermission: true } })
  })

  it('ignores a slower answer for a folder that is no longer open', async () => {
    const slow = gate<Response>()
    const api = fakeApi((call) =>
      (call.body as { from: string }).from === 'old' ? slow.promise : page([item('new', 1)]),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    const first = s.openFolder('old')
    await s.openFolder('new')
    slow.release(page([item('old', 2)]))
    await first
    expect(s.rows.value.map((r) => r.id)).toEqual(['new'])
  })

  it('fetches an item that is not in the list', async () => {
    const { s, calls } = await opened(() => json(item('far', 99)), [])
    expect(await s.openItem('far')).toMatchObject({ state: 'ready', data: { seqId: 99 } })
    expect(calls.at(-1)?.path).toBe('/v1/workspaces/w/items/far')
    expect(s.view('far')?.seqId).toBe(99)
  })
})

describe('useItems: sorting', () => {
  type QueryBody = { from: string; cursor: string | null; sort: unknown[] }
  const queries = (calls: Call[]) =>
    calls.filter((c) => c.path.endsWith('/query')).map((c) => c.body as QueryBody)

  it('offers sorting only on indexed attributes of a sortable type', () => {
    const [title, stage, points] = attributes as [Attribute, Attribute, Attribute]
    expect(canSort(stage)).toBe(true)
    expect(canSort(title)).toBe(false)
    expect(canSort({ ...title, indexed: true })).toBe(true)
    expect(canSort({ ...points, indexed: true })).toBe(true)
    const relation: Attribute = {
      ...title,
      indexed: true,
      version: 0,
      type: 'relation',
      config: { targetHubId: 'bld', crossHub: false, multiple: true },
    }
    expect(canSort(relation)).toBe(false)
  })

  it('cycles a column through ascending, descending and the default order', () => {
    const asc = nextSort(null, 'stage')
    expect(asc).toEqual({ attribute: 'stage', direction: 'asc' })
    const desc = nextSort(asc, 'stage')
    expect(desc).toEqual({ attribute: 'stage', direction: 'desc' })
    expect(nextSort(desc, 'stage')).toBeNull()
    expect(nextSort(desc, 'points')).toEqual({ attribute: 'points', direction: 'asc' })
  })

  it('queries the new order, keeping the rows until it arrives', async () => {
    const sorted = gate<Response>()
    const api = fakeApi((call) =>
      (call.body as QueryBody).sort.length ? sorted.promise : page([item('i2', 2), item('i1', 1)]),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    const done = s.setSort({ attribute: 'stage', direction: 'desc' })
    expect(s.sort.value).toEqual({ attribute: 'stage', direction: 'desc' })
    expect(s.list.value).toMatchObject({ state: 'ready', data: { sorting: true, sort: null } })
    expect(s.rows.value.map((r) => r.id)).toEqual(['i2', 'i1'])
    sorted.release(page([item('i1', 1), item('i2', 2)]))
    await done
    expect(queries(api.calls).at(-1)).toMatchObject({
      cursor: null,
      sort: [{ attribute: 'stage', direction: 'desc' }],
    })
    expect(s.rows.value.map((r) => r.id)).toEqual(['i1', 'i2'])
    expect(s.list.value).toMatchObject({
      state: 'ready',
      data: { sorting: false, sort: { attribute: 'stage', direction: 'desc' } },
    })
  })

  it('pages a sorted list with the same sort and its cursor', async () => {
    const api = fakeApi((call) => {
      const body = call.body as QueryBody
      return body.cursor === 's1' ? page([item('i3', 3)]) : page([item('i1', 1)], 's1')
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    await s.setSort({ attribute: 'stage', direction: 'asc' })
    await s.loadMore()
    expect(queries(api.calls).at(-1)).toMatchObject({
      cursor: 's1',
      sort: [{ attribute: 'stage', direction: 'asc' }],
    })
    expect(s.rows.value.map((r) => r.id)).toEqual(['i1', 'i3'])
  })

  it('does not load more while a new order is loading', async () => {
    const sorted = gate<Response>()
    const api = fakeApi((call) =>
      (call.body as QueryBody).sort.length ? sorted.promise : page([item('i1', 1)], 'c1'),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    const done = s.setSort({ attribute: 'stage', direction: 'asc' })
    await s.loadMore()
    expect(queries(api.calls).filter((b) => b.cursor === 'c1')).toHaveLength(0)
    sorted.release(page([item('i1', 1)]))
    await done
  })

  it('drops a page loaded for the old order', async () => {
    const more = gate<Response>()
    const api = fakeApi((call) => {
      const body = call.body as QueryBody
      if (body.cursor === 'c1') return more.promise
      return body.sort.length ? page([item('s1', 1)]) : page([item('i1', 1)], 'c1')
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    const loading = s.loadMore()
    await s.setSort({ attribute: 'stage', direction: 'asc' })
    more.release(page([item('old', 2)]))
    await loading
    expect(s.rows.value.map((r) => r.id)).toEqual(['s1'])
    expect(s.list.value).toMatchObject({ state: 'ready', data: { more: false } })
  })

  it('keeps the latest of two quick sorts', async () => {
    const first = gate<Response>()
    const api = fakeApi((call) => {
      const sort = (call.body as QueryBody).sort as { direction: string }[]
      if (sort[0]?.direction === 'asc') return first.promise
      return sort.length ? page([item('desc', 1)]) : page([item('i1', 1)])
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    const a = s.setSort({ attribute: 'stage', direction: 'asc' })
    await s.setSort({ attribute: 'stage', direction: 'desc' })
    first.release(page([item('asc', 1)]))
    await a
    expect(s.rows.value.map((r) => r.id)).toEqual(['desc'])
    expect(s.sort.value).toEqual({ attribute: 'stage', direction: 'desc' })
  })

  it('rolls back to the previous order with a message when the API refuses', async () => {
    const api = fakeApi((call) =>
      (call.body as QueryBody).sort.length
        ? json(
            {
              error: 'invalid_request',
              message: 'sort.0: Attribute "stage" is not indexed',
              errors: [{ path: 'sort.0', message: 'Attribute "stage" is not indexed' }],
            },
            400,
          )
        : page([item('i1', 1)], 'c1'),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    await s.setSort({ attribute: 'stage', direction: 'asc' })
    expect(s.sort.value).toBeNull()
    expect(s.list.value).toMatchObject({
      state: 'ready',
      data: { sorting: false, sort: null, nextCursor: 'c1' },
    })
    expect(s.rows.value.map((r) => r.id)).toEqual(['i1'])
    expect(s.notice.value).toBe(
      'This column can no longer be sorted; reload the page to see the current columns. The items are shown in the previous order.',
    )
  })

  it('does not blame the column for a 400 that does not name the sort', async () => {
    const api = fakeApi((call) =>
      (call.body as QueryBody).sort.length
        ? json({ error: 'invalid_request', message: 'limit: Too big' }, 400)
        : page([item('i1', 1)]),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    await s.setSort({ attribute: 'stage', direction: 'asc' })
    expect(s.sort.value).toBeNull()
    expect(s.notice.value).toBe(
      'The items could not be shown in that order. limit: Too big. The items are shown in the previous order.',
    )
  })

  it('names any other failure and keeps the rows', async () => {
    const api = fakeApi((call) =>
      (call.body as QueryBody).sort.length
        ? json({ error: 'internal', message: 'Database unavailable' }, 500)
        : page([item('i1', 1)]),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    await s.setSort({ attribute: 'stage', direction: 'desc' })
    expect(s.notice.value).toBe(
      'The items could not be shown in that order. Database unavailable. The items are shown in the previous order.',
    )
    expect(s.rows.value.map((r) => r.id)).toEqual(['i1'])
  })

  it('keeps the order on retry, and starts another folder in the default order', async () => {
    const api = fakeApi(() => page([item('i1', 1)]))
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    await s.setSort({ attribute: 'stage', direction: 'asc' })
    await s.openFolder('bld')
    expect(queries(api.calls).at(-1)?.sort).toEqual([{ attribute: 'stage', direction: 'asc' }])
    await s.openFolder('b')
    expect(s.sort.value).toBeNull()
    expect(queries(api.calls).at(-1)).toMatchObject({ from: 'b', sort: [] })
  })
})

describe('useItems: a sort that went stale (#81)', () => {
  type QueryBody = { from: string; sort: unknown[] }
  const sorts = (calls: Call[]) =>
    calls.filter((c) => c.path.endsWith('/query')).map((c) => (c.body as QueryBody).sort)
  const stage = { attribute: 'stage', direction: 'asc' } as const
  const refused = () =>
    json(
      {
        error: 'invalid_request',
        message: 'sort.0: Attribute "stage" is not indexed',
        errors: [{ path: 'sort.0', message: 'Attribute "stage" is not indexed' }],
      },
      400,
    )
  const notice =
    'The table can no longer be sorted by that column, so the items are shown newest update first.'

  /** A folder sorted by stage, whose next query is answered by `next`. */
  async function sortedThen(next: (body: QueryBody) => Response | Promise<Response>) {
    let sorted = false
    const api = fakeApi((call) => {
      if (!sorted) return page([item('i1', 1)])
      return next(call.body as QueryBody)
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    await s.setSort(stage)
    sorted = true
    return { s, calls: api.calls }
  }

  it('tells a refused sort from other 400s by the error path', () => {
    const refusal = (errors: unknown, status = 400) =>
      new ApiRequestError('invalid_request', 'x', status, {
        error: 'invalid_request',
        message: 'x',
        errors,
      })
    expect(refusedSort(refusal([{ path: 'sort.0', message: 'm' }]))).toBe(true)
    expect(refusedSort(refusal([{ path: 'where.and.0', message: 'm' }, { path: 'sort' }]))).toBe(
      true,
    )
    expect(refusedSort(refusal([{ path: 'where.and.0', message: 'm' }]))).toBe(false)
    expect(refusedSort(refusal([{ path: 'sorting', message: 'm' }]))).toBe(false)
    expect(refusedSort(refusal([]))).toBe(false)
    expect(refusedSort(refusal(undefined))).toBe(false)
    expect(refusedSort(refusal([{ path: 'sort.0', message: 'm' }], 500))).toBe(false)
  })

  it('drops a refused sort on reopen and loads the default order', async () => {
    const { s, calls } = await sortedThen((body) =>
      body.sort.length ? refused() : page([item('i2', 2)]),
    )
    await s.openFolder('bld')
    expect(sorts(calls).slice(-2)).toEqual([[stage], []])
    expect(s.sort.value).toBeNull()
    expect(s.list.value).toMatchObject({ state: 'ready', data: { sort: null } })
    expect(s.rows.value.map((r) => r.id)).toEqual(['i2'])
    expect(s.notice.value).toBe(notice)
    // Retrying again does not send the refused sort.
    await s.openFolder('bld')
    expect(sorts(calls).at(-1)).toEqual([])
  })

  it('keeps the sort, and shows the error, for a failure that does not name it', async () => {
    const { s, calls } = await sortedThen(() =>
      json({ error: 'invalid_request', message: 'Invalid cursor' }, 400),
    )
    await s.openFolder('bld')
    expect(sorts(calls).at(-1)).toEqual([stage])
    expect(s.sort.value).toEqual(stage)
    expect(s.list.value).toMatchObject({ state: 'error', error: { status: 400 } })
    expect(s.notice.value).toBeNull()
  })

  it('shows the error state if the default order fails too', async () => {
    const { s } = await sortedThen((body) =>
      body.sort.length ? refused() : json({ error: 'internal', message: 'Down' }, 500),
    )
    await s.openFolder('bld')
    expect(s.sort.value).toBeNull()
    expect(s.list.value).toMatchObject({ state: 'error', error: { status: 500 } })
    // Nothing is shown newest update first, so the notice does not say so (#85).
    expect(s.notice.value).toBeNull()
  })

  it('sets the notice only once the default order is shown (#85)', async () => {
    const defaultRead = gate<Response>()
    const { s } = await sortedThen((body) => (body.sort.length ? refused() : defaultRead.promise))
    const done = s.openFolder('bld')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.list.value.state).toBe('loading')
    expect(s.notice.value).toBeNull()
    defaultRead.release(page([item('i2', 2)]))
    await done
    expect(s.notice.value).toBe(notice)
  })

  it('clears the notice once the rows are sorted again (#87)', async () => {
    const points = { attribute: 'points', direction: 'desc' } as const
    const { s } = await sortedThen((body) =>
      body.sort.length && (body.sort[0] as { attribute: string }).attribute === 'stage'
        ? refused()
        : page([item('i2', 2)]),
    )
    await s.openFolder('bld')
    expect(s.notice.value).toBe(notice)
    await s.setSort(points)
    expect(s.list.value).toMatchObject({ state: 'ready', data: { sort: points } })
    expect(s.notice.value).toBeNull()
  })

  it('does not claim the default order when a dropped sort is followed by a failed read', async () => {
    const { s } = await sortedThen(() => json({ error: 'internal', message: 'Down' }, 500))
    await s.openFolder('bld', [], ['points'])
    expect(s.list.value).toMatchObject({ state: 'error', error: { status: 500 } })
    expect(s.notice.value).toBeNull()
  })

  it('does not send a kept sort the folder columns no longer allow', async () => {
    const { s, calls } = await sortedThen(() => page([item('i2', 2)]))
    await s.openFolder('bld', [], ['points'])
    expect(sorts(calls).at(-1)).toEqual([])
    expect(s.sort.value).toBeNull()
    expect(s.notice.value).toBe(notice)
  })

  it('keeps a sort the folder columns still allow', async () => {
    const { s, calls } = await sortedThen(() => page([item('i2', 2)]))
    await s.openFolder('bld', [], ['stage'])
    expect(sorts(calls).at(-1)).toEqual([stage])
    expect(s.notice.value).toBeNull()
  })

  describe('"Load more" in a refused sort (#85)', () => {
    const moreNotice =
      'The table can no longer be sorted by that column, so no more items can be loaded in this order. Show them newest update first to see the rest.'

    /** A folder sorted by stage with a next page, whose later queries are answered by `next`. */
    async function sortedWithMore(next: (body: QueryBody & { cursor: string | null }) => Response) {
      let sorted = false
      const api = fakeApi((call) => {
        if (!sorted) return page([item('i1', 1)], 's1')
        return next(call.body as QueryBody & { cursor: string | null })
      })
      const s = useItems('w', () => 'BLD', api.fetchFn)
      await s.openFolder('bld')
      await s.setSort(stage)
      sorted = true
      return { s, calls: api.calls }
    }

    it('keeps the rows, stops retrying, and says why', async () => {
      const { s, calls } = await sortedWithMore(() => refused())
      await s.loadMore()
      expect(sorts(calls)).toEqual([[], [stage], [stage]])
      expect(s.rows.value.map((r) => r.id)).toEqual(['i1'])
      expect(s.sort.value).toEqual(stage)
      expect(s.list.value).toMatchObject({
        state: 'ready',
        data: { sort: stage, moreRefused: true, moreError: null, more: false, nextCursor: 's1' },
      })
      expect(s.notice.value).toBe(moreNotice)
      // A second "Load more" sends nothing.
      await s.loadMore()
      expect(calls).toHaveLength(3)
    })

    it('reloads in the default order when asked, and clears the notice', async () => {
      const { s, calls } = await sortedWithMore((body) =>
        body.sort.length ? refused() : page([item('i2', 2)], 'd1'),
      )
      await s.loadMore()
      await s.setSort(null)
      expect(sorts(calls).at(-1)).toEqual([])
      expect(s.rows.value.map((r) => r.id)).toEqual(['i2'])
      expect(s.list.value).toMatchObject({
        state: 'ready',
        data: { sort: null, moreRefused: false, nextCursor: 'd1' },
      })
      expect(s.notice.value).toBeNull()
    })

    it('keeps the offer if the default order cannot be read', async () => {
      const { s } = await sortedWithMore((body) =>
        body.sort.length ? refused() : json({ error: 'internal', message: 'Down' }, 500),
      )
      await s.loadMore()
      await s.setSort(null)
      expect(s.rows.value.map((r) => r.id)).toEqual(['i1'])
      expect(s.list.value).toMatchObject({ state: 'ready', data: { moreRefused: true } })
      expect(s.notice.value).toMatch(/could not be shown in that order\. Down\./)
    })

    it('clears the notice when the default order is read on a second try', async () => {
      let down = true
      const { s } = await sortedWithMore((body) => {
        if (body.sort.length) return refused()
        return down
          ? json({ error: 'internal', message: 'Down' }, 500)
          : page([item('i2', 2)], 'd1')
      })
      await s.loadMore()
      await s.setSort(null)
      expect(s.notice.value).toMatch(/shown in the previous order/)
      down = false
      await s.setSort(null)
      expect(s.rows.value.map((r) => r.id)).toEqual(['i2'])
      expect(s.list.value).toMatchObject({
        state: 'ready',
        data: { sort: null, moreRefused: false },
      })
      expect(s.notice.value).toBeNull()
    })

    it('keeps an edit failure notice when a sort succeeds', async () => {
      const { s } = await opened(
        () => json({ error: 'invalid_values', message: 'Some values are not valid' }, 422),
        [item('i1', 1, { title: 'Old' })],
      )
      await s.save('i1', { title: '' })
      await s.setSort(stage)
      expect(s.list.value).toMatchObject({ state: 'ready', data: { sort: stage } })
      expect(s.notice.value).toBe('Your change to BLD-1 was not saved. Some values are not valid')
    })

    it('treats a 400 that does not name the sort as a failed page, which can be retried', async () => {
      const { s } = await sortedWithMore(() =>
        json({ error: 'invalid_request', message: 'Invalid cursor' }, 400),
      )
      await s.loadMore()
      expect(s.list.value).toMatchObject({
        state: 'ready',
        data: { moreRefused: false, moreError: { status: 400 } },
      })
      expect(s.notice.value).toBeNull()
    })
  })

  it('keeps reload internal', () => {
    const s = useItems('w', () => 'BLD', fakeApi(() => page([])).fetchFn)
    expect('reload' in s).toBe(false)
  })
})

describe('useItems: editing', () => {
  it('shows an edit at once, then takes the server version', async () => {
    const answer = gate<Response>()
    const { s, calls } = await opened(() => answer.promise, [item('i1', 1, { title: 'Old' })])
    const saved = s.save('i1', { title: 'New' })
    expect(s.view('i1')?.values['title']).toBe('New')
    expect(s.isSaving('i1')).toBe(true)
    answer.release(json(item('i1', 1, { title: 'New' }, 2)))
    expect(await saved).toBe(true)
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      path: '/v1/workspaces/w/items/i1',
      body: { version: 1, values: { title: 'New' } },
    })
    expect(s.view('i1')).toMatchObject({ version: 2, values: { title: 'New' } })
    expect(s.isSaving('i1')).toBe(false)
  })

  it('rolls back to the current item on 409 and says so', async () => {
    const current = item('i1', 7, { title: 'Theirs' }, 3)
    const { s } = await opened(
      () => json({ error: 'conflict', message: 'Changed', current }, 409),
      [item('i1', 7, { title: 'Old' })],
    )
    const saved = s.save('i1', { title: 'Mine' })
    expect(s.view('i1')?.values['title']).toBe('Mine')
    expect(await saved).toBe(false)
    expect(s.view('i1')).toMatchObject({ version: 3, values: { title: 'Theirs' } })
    expect(s.notice.value).toContain('BLD-7 was changed by someone else')
  })

  it('drops queued edits after a conflict', async () => {
    const current = item('i1', 1, { title: 'Theirs' }, 3)
    const { s, calls } = await opened(
      () => json({ error: 'conflict', message: 'Changed', current }, 409),
      [item('i1', 1, { title: 'Old' })],
    )
    const results = await Promise.all([s.save('i1', { title: 'A' }), s.save('i1', { points: 2 })])
    expect(results).toEqual([false, false])
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
    expect(s.view('i1')?.values).toEqual({ title: 'Theirs' })
  })

  it('rolls back any other rejection with the server message', async () => {
    const { s } = await opened(
      () => json({ error: 'invalid_values', message: 'Some values are not valid' }, 422),
      [item('i1', 1, { title: 'Old' })],
    )
    expect(await s.save('i1', { title: '' })).toBe(false)
    expect(s.view('i1')?.values['title']).toBe('Old')
    expect(s.notice.value).toBe('Your change to BLD-1 was not saved. Some values are not valid')
    s.dismissNotice()
    expect(s.notice.value).toBeNull()
  })

  it('sends quick edits one after another, each with the latest version', async () => {
    let version = 1
    const { s, calls } = await opened(
      (call) => {
        const body = call.body as { values: Item['values'] }
        version++
        return json(item('i1', 1, body.values, version))
      },
      [item('i1', 1)],
    )
    await Promise.all([s.save('i1', { title: 'A' }), s.save('i1', { points: 2 })])
    expect(
      calls.filter((c) => c.method === 'PATCH').map((c) => (c.body as { version: number }).version),
    ).toEqual([1, 2])
  })
})

describe('useItems: creating', () => {
  it('adds the row at once and keeps it when the server confirms', async () => {
    const answer = gate<Response>()
    const { s, calls } = await opened(() => answer.promise, [item('i1', 1)])
    const created = s.create({ title: 'Fresh' })
    const id = s.rows.value[0]?.id ?? ''
    expect(s.rows.value).toHaveLength(2)
    expect(s.isCreating(id)).toBe(true)
    const body = calls.at(-1)?.body as { id: string; folderId: string; values: unknown }
    expect(body).toEqual({
      id,
      folderId: 'bld',
      values: { title: 'Fresh' },
      clientMutationId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
    })
    answer.release(json(item(id, 2, { title: 'Fresh' }), 201))
    expect(await created).toMatchObject({ ok: true, item: { id, seqId: 2 } })
    expect(s.isCreating(id)).toBe(false)
    expect(s.rows.value.map((r) => r.seqId)).toEqual([2, 1])
  })

  it('removes the row and reports field errors when the server refuses', async () => {
    const { s } = await opened(
      () =>
        json(
          {
            error: 'invalid_values',
            message: 'Some values are not valid',
            errors: [{ attributeId: 'title', code: 'required', message: 'A value is required' }],
          },
          422,
        ),
      [item('i1', 1)],
    )
    const result = await s.create({})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(valueErrors(result.error)).toEqual({ title: 'A value is required' })
    expect(s.rows.value.map((r) => r.id)).toEqual(['i1'])
    expect(s.notice.value).toContain('The item was not created')
  })

  it('does not send an edit for an item the server has not confirmed', async () => {
    const answer = gate<Response>()
    const { s, calls } = await opened(() => answer.promise, [item('i1', 1)])
    const created = s.create({ title: 'Fresh' })
    const id = s.rows.value[0]?.id ?? ''
    const sent = calls.length
    expect(await s.save(id, { title: 'Edited' })).toBe(false)
    expect(calls).toHaveLength(sent)
    expect(s.view(id)?.values).toEqual({ title: 'Fresh' })
    expect(s.notice.value).toContain('still being saved')
    answer.release(json(item(id, 2, { title: 'Fresh' }), 201))
    await created
  })
})

describe('inHub', () => {
  it('passes an item of this hub through', () => {
    const ready = { state: 'ready' as const, data: item('i1', 1) }
    expect(inHub(ready, 'bld')).toBe(ready)
  })

  it('reports an item of another hub as missing', () => {
    const other = { state: 'ready' as const, data: { ...item('i1', 1), hubId: 'ops' } }
    expect(inHub(other, 'bld')).toMatchObject({ state: 'error', error: { status: 404 } })
  })
})

describe('useItems: linked items (#50)', () => {
  const linking = (links: string[]) => item('i1', 1, { blocks: links })

  it('expands relation columns and keeps what the server says about each linked item', async () => {
    const target = item('t1', 5, { title: 'Target' })
    const api = fakeApi(() =>
      json({
        items: [linking(['t1', 't2', 't3'])],
        nextCursor: null,
        linked: { t1: { access: 'read', item: target }, t2: { access: 'none' } },
        linkedTruncated: false,
      }),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld', ['blocks'])
    expect(api.calls[0]?.body).toMatchObject({ expand: ['blocks'] })
    expect(s.linkState('t1')).toEqual({ access: 'read', item: target })
    expect(s.linkState('t2')).toEqual({ access: 'none' })
    // Expanded, not truncated, and not in `linked`: deleted.
    expect(s.linkState('t3')).toEqual({ access: 'gone' })
    expect(s.linkState('t9')).toEqual({ access: 'unknown' })
  })

  it('does not call an item deleted when the server cut the linked list short', async () => {
    const api = fakeApi(() =>
      json({ items: [linking(['t3'])], nextCursor: null, linked: {}, linkedTruncated: true }),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld', ['blocks'])
    expect(s.linkState('t3')).toEqual({ access: 'unknown' })
  })

  it('reads uncovered linked items one by one; a 404 shows as no access', async () => {
    const api = fakeApi((call) => {
      if (call.path.endsWith('/query')) return json({ items: [], nextCursor: null })
      if (call.path.endsWith('/t1')) return json(item('t1', 5))
      if (call.path.endsWith('/t2')) return json({ error: 'not_found', message: 'Not found' }, 404)
      return json({ error: 'internal', message: 'Boom' }, 500)
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    s.resolveLinked(['t1', 't2', 't3'])
    s.resolveLinked(['t1'])
    await new Promise((r) => setTimeout(r, 0))
    expect(api.calls.filter((c) => c.path.endsWith('/t1'))).toHaveLength(1)
    expect(s.linkState('t1')).toMatchObject({ access: 'read' })
    expect(s.linkState('t2')).toEqual({ access: 'none' })
    expect(s.linkState('t3')).toEqual({ access: 'error' })
  })

  it('reads at most a few linked items at once', async () => {
    const held = gate<undefined>()
    const api = fakeApi(async (call) => {
      if (call.path.endsWith('/query')) return json({ items: [], nextCursor: null })
      await held.promise
      return json(item(call.path.split('/').at(-1) ?? '', 5))
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    const ids = Array.from({ length: 10 }, (_, n) => `t${String(n)}`)
    s.resolveLinked(ids)
    s.resolveLinked(ids)
    const reads = () => api.calls.filter((c) => c.method === 'GET')
    expect(reads()).toHaveLength(LINKED_READ_LIMIT)
    held.release(undefined)
    await new Promise((r) => setTimeout(r, 0))
    expect(reads()).toHaveLength(10)
    expect(ids.every((id) => s.linkState(id).access === 'read')).toBe(true)
  })

  it('waits for the folder query, whose answer wins over a direct read', async () => {
    const list = gate<Response>()
    const api = fakeApi((call) =>
      call.path.endsWith('/query') ? list.promise : json(item('t1', 5)),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    const opening = s.openFolder('bld', ['blocks'])
    s.resolveLinked(['t1'])
    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(0)
    list.release(
      json({
        items: [item('i1', 1, { blocks: ['t1'] })],
        nextCursor: null,
        linked: { t1: { access: 'none' } },
        linkedTruncated: false,
      }),
    )
    await opening
    s.resolveLinked(['t1'])
    expect(s.linkState('t1')).toEqual({ access: 'none' })
    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(0)
  })

  it('remembers an item picked to link to', () => {
    const s = useItems('w', () => 'BLD', fakeApi(() => json({})).fetchFn)
    s.rememberLinked(item('t1', 5))
    expect(s.linkState('t1')).toMatchObject({ access: 'read' })
  })
})

describe('useItems: no permission to edit (#50)', () => {
  it('rolls back a refused edit and turns the hub read-only', async () => {
    const { s } = await opened(
      () => json({ error: 'forbidden', message: 'Forbidden' }, 403),
      [item('i1', 1, { title: 'Old' })],
    )
    expect(s.readOnly.value).toBe(false)
    expect(await s.save('i1', { title: 'New' })).toBe(false)
    expect(s.view('i1')?.values['title']).toBe('Old')
    expect(s.readOnly.value).toBe(true)
    expect(s.notice.value).toContain('You can view the items in this hub but not change them')
  })

  it('removes the row of a refused create and turns the hub read-only', async () => {
    const { s } = await opened(
      () => json({ error: 'forbidden', message: 'Forbidden' }, 403),
      [item('i1', 1)],
    )
    const result = await s.create({ title: 'Fresh' })
    expect(result.ok).toBe(false)
    expect(s.rows.value.map((r) => r.id)).toEqual(['i1'])
    expect(s.readOnly.value).toBe(true)
    expect(s.notice.value).toBe(
      'The item was not created. You can view the items in this hub but not add them.',
    )
  })
})

describe('newItemId (#119)', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('uses randomUUID where the browser has it', () => {
    expect(newItemId({ randomUUID: () => 'a-b-c-d-e', getRandomValues: (b) => b })).toBe(
      'a-b-c-d-e',
    )
  })

  it('makes a v4 UUID without randomUUID, as over plain HTTP on another host', () => {
    const id = newItemId({ getRandomValues: (b) => crypto.getRandomValues(b) })
    expect(id).toMatch(uuid)
    const zeros = newItemId({ getRandomValues: <T extends ArrayBufferView | null>(b: T) => b })
    expect(zeros).toBe('00000000-0000-4000-8000-000000000000')
  })
})

describe('useItems: an item page without a list (#119)', () => {
  it('reads an item with expand and keeps its linked items, and a missing one as gone', async () => {
    const target = item('t1', 5, { title: 'Target' })
    const api = fakeApi(() =>
      json({
        ...item('i1', 1, { blocks: ['t1', 't2', 't3'] }),
        linked: { t1: { access: 'read', item: target }, t2: { access: 'none' } },
        linkedTruncated: false,
      }),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn, { list: false })
    const result = await s.readItem('i1', ['blocks', 'parent'])
    expect(api.calls[0]?.path).toBe('/v1/workspaces/w/items/i1?expand=blocks,parent')
    expect(result).toMatchObject({ state: 'ready', data: { id: 'i1' } })
    expect(s.view('i1')).not.toHaveProperty('linked')
    expect(s.linkState('t1')).toEqual({ access: 'read', item: target })
    expect(s.linkState('t2')).toEqual({ access: 'none' })
    expect(s.linkState('t3')).toEqual({ access: 'gone' })
  })

  it('keeps a newer version than the one read', async () => {
    const api = fakeApi((call) =>
      call.path.includes('expand') ? json(item('i1', 1, {}, 1)) : json(item('i1', 1, {}, 3)),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn, { list: false })
    await s.openItem('i1')
    await s.readItem('i1', ['blocks'])
    expect(s.view('i1')?.version).toBe(3)
  })

  it('reports a failed read without touching the store', async () => {
    const api = fakeApi(() => json({ error: 'not_found', message: 'Item not found' }, 404))
    const s = useItems('w', () => 'BLD', api.fetchFn, { list: false })
    expect(await s.readItem('i1', [])).toMatchObject({ state: 'error', error: { status: 404 } })
    expect(s.view('i1')).toBeUndefined()
  })

  it('reads linked items at once, since no list query will cover them', async () => {
    const api = fakeApi((call) => json(item(call.path.split('/').at(-1) ?? '', 5)))
    const s = useItems('w', () => 'BLD', api.fetchFn, { list: false })
    s.resolveLinked(['t1'])
    await new Promise((r) => setTimeout(r, 0))
    expect(api.calls.map((c) => c.path)).toEqual(['/v1/workspaces/w/items/t1'])
    expect(s.linkState('t1')).toMatchObject({ access: 'read' })
  })
})

describe('useItems: deleting (#119)', () => {
  async function loaded(handler: (call: Call) => Response | Promise<Response>) {
    const api = fakeApi((call) =>
      call.method === 'GET' ? json(item('i1', 7, { title: 'Old' }, 2)) : handler(call),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn, { list: false })
    await s.openItem('i1')
    return { s, calls: api.calls }
  }

  it('deletes at the version shown', async () => {
    const { s, calls } = await loaded(() => new Response(null, { status: 204 }))
    expect(await s.remove('i1')).toEqual({ ok: true })
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', body: undefined })
    expect(calls.at(-1)?.path).toMatch(
      /^\/v1\/workspaces\/w\/items\/i1\?version=2&clientMutationId=[0-9a-f-]{36}$/,
    )
  })

  it('removes a deleted row from an open list', async () => {
    const api = fakeApi((call) =>
      call.method === 'DELETE' ? new Response(null, { status: 204 }) : page([item('i1', 1)]),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    expect(await s.remove('i1')).toEqual({ ok: true })
    expect(s.rows.value).toEqual([])
  })

  it('shows the current item on 409 and does not delete', async () => {
    const current = item('i1', 7, { title: 'Theirs' }, 3)
    const { s } = await loaded(() =>
      json({ error: 'conflict', message: 'Version mismatch', current }, 409),
    )
    const result = await s.remove('i1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('BLD-7 was changed by someone else')
    expect(s.view('i1')).toEqual(current)
  })

  it('turns read-only when the server refuses with 403', async () => {
    const { s } = await loaded(() => json({ error: 'forbidden', message: 'No' }, 403))
    const result = await s.remove('i1')
    expect(result.ok).toBe(false)
    expect(s.readOnly.value).toBe(true)
  })

  it('counts a 404 as done: the item is gone either way', async () => {
    const { s } = await loaded(() => json({ error: 'not_found', message: 'Item not found' }, 404))
    expect(await s.remove('i1')).toEqual({ ok: true })
  })

  it('names any other failure', async () => {
    const { s } = await loaded(() => json({ error: 'internal', message: 'Database down' }, 500))
    expect(await s.remove('i1')).toEqual({
      ok: false,
      message: 'BLD-7 was not deleted. Database down.',
    })
  })

  it('waits for an edit on its way, then deletes at the new version', async () => {
    const answer = gate<Response>()
    const { s, calls } = await loaded((call) =>
      call.method === 'PATCH' ? answer.promise : new Response(null, { status: 204 }),
    )
    const saved = s.save('i1', { title: 'New' })
    const removed = s.remove('i1')
    answer.release(json(item('i1', 7, { title: 'New' }, 3)))
    await saved
    expect(await removed).toEqual({ ok: true })
    expect(calls.at(-1)?.path).toMatch(/^\/v1\/workspaces\/w\/items\/i1\?version=3&/)
  })
})

// From M3-03 the API adds the workspace `seq` to item, query and write responses (D58). The
// strict item schema would refuse it, so these must keep working, and the store keeps items
// without it (issue 168).
describe('useItems: responses carrying seq', () => {
  const withSeq = (body: object, seq = 7) => ({ ...body, seq })

  it('drops seq and nothing else', () => {
    const i = item('i1', 1)
    expect(withoutSeq({ ...i, seq: 3 })).toEqual(i)
    expect(withoutSeq(i)).toEqual(i)
  })

  it('reads a query page and a single item', async () => {
    const api = fakeApi((call) =>
      call.path.endsWith('/query')
        ? json(withSeq({ items: [item('i1', 1)], nextCursor: null }))
        : json(withSeq(item('far', 99))),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    expect(s.list.value.state).toBe('ready')
    expect(s.rows.value.map((r) => r.id)).toEqual(['i1'])
    expect(await s.openItem('far')).toMatchObject({ state: 'ready', data: { seqId: 99 } })
    expect(await s.readItem('far', [])).toMatchObject({ state: 'ready' })
    expect(s.view('far')).not.toHaveProperty('seq')
  })

  it('saves and creates', async () => {
    const { s } = await opened(
      (call) =>
        call.method === 'PATCH'
          ? json(withSeq(item('i1', 1, { title: 'New' }, 2)))
          : json(withSeq(item((call.body as { id: string }).id, 2, { title: 'Fresh' })), 201),
      [item('i1', 1)],
    )
    expect(await s.save('i1', { title: 'New' })).toBe(true)
    expect(s.view('i1')).toMatchObject({ version: 2, values: { title: 'New' } })
    expect(s.view('i1')).not.toHaveProperty('seq')
    const created = await s.create({ title: 'Fresh' })
    expect(created.ok).toBe(true)
    if (created.ok) expect(created.item).not.toHaveProperty('seq')
  })
})
