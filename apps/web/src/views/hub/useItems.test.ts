import type { Attribute, Item } from '@16bit/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attributes,
  fakeApi,
  item,
  json,
  rowsOf,
  withSeq,
  type Call,
} from './fixtures.test-utils.ts'
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

/**
 * Holds the next `yieldToMain`, so a window read stops part-way through its slices (issue 218).
 * Every other yield is the real one.
 */
const yields = vi.hoisted(() => ({ next: null as null | (() => Promise<void>) }))
vi.mock('../../api/yield.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/yield.ts')>()
  return {
    yieldToMain: () => {
      const next = yields.next
      yields.next = null
      return next ? next() : actual.yieldToMain()
    },
  }
})
/** `at` resolves when a read reaches the next yield; it waits there until `release`. */
function holdNextYield() {
  let reached: () => void = () => undefined
  const at = new Promise<void>((resolve) => {
    reached = resolve
  })
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  yields.next = () => {
    reached()
    return held
  }
  return { at, release }
}

/** A window of the folder query (D61), with the folder's total. */
const page = (items: Item[], total = items.length) =>
  json(withSeq({ items, nextCursor: null, total }))

/** The table shows rows `start` to `end`, held by the windows at `offsets`. */
const inView = (start: number, end: number, offsets: number[]) => ({ start, end, offsets })

/** Lets a window read finish: it checks and takes in its rows over several tasks (issue 218). */
const tick = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

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
  it('queries the first window by item number, newest first, and keeps the server order', async () => {
    const { s, calls } = await opened(() => json({}), [item('i2', 2), item('i1', 1)])
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/workspaces/w/query',
      body: {
        from: 'bld',
        limit: 200,
        offset: 0,
        count: true,
        expand: [],
        sort: [],
        order: 'number',
      },
    })
    expect(rowsOf(s).map((r) => r.id)).toEqual(['i2', 'i1'])
    expect(s.list.value).toMatchObject({ state: 'ready', data: { total: 2 } })
  })

  it('sizes the rows by the total and reads each window the table asks for, once', async () => {
    const first = Array.from({ length: 200 }, (_, i) => item(`a${String(i)}`, 500 - i))
    const api = fakeApi((call) => {
      const { offset } = call.body as { offset: number }
      return offset === 0 ? page(first, 450) : page([item('b0', 300), item('b1', 299)], 450)
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    expect(s.list.value).toMatchObject({ state: 'ready', data: { total: 450 } })
    expect(s.rowAt(199)?.id).toBe('a199')
    expect(s.rowAt(200)).toBeUndefined()
    // The window in view is loaded: nothing is read.
    s.showWindows(inView(0, 18, [0]))
    expect(api.calls).toHaveLength(1)
    // Scrolled across a window edge: only the window not loaded is read, and only once.
    s.showWindows(inView(190, 215, [0, 200]))
    s.showWindows(inView(192, 217, [0, 200]))
    await tick()
    expect(api.calls.map((c) => (c.body as { offset: number }).offset)).toEqual([0, 200])
    expect(s.rowAt(200)?.id).toBe('b0')
    expect(s.indexOf('b1')).toBe(201)
  })

  it('keeps a failed window as placeholders, says which rows, and reads it again on retry', async () => {
    let down = true
    const api = fakeApi((call) => {
      const { offset } = call.body as { offset: number }
      if (offset === 0) return page([item('a0', 9)], 300)
      return down ? json({ error: 'internal', message: 'Down' }, 500) : page([item('b0', 1)], 300)
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    s.showWindows(inView(200, 220, [200]))
    await tick()
    expect(s.list.value).toMatchObject({
      state: 'ready',
      data: { failed: [200], failure: { message: 'Down' } },
    })
    expect(s.rowAt(200)).toBeUndefined()
    // Scrolling does not hammer a failed window; the retry reads it.
    s.showWindows(inView(201, 221, [200]))
    expect(api.calls).toHaveLength(2)
    down = false
    s.retryWindows()
    await tick()
    expect(s.rowAt(200)?.id).toBe('b0')
    expect(s.list.value).toMatchObject({ state: 'ready', data: { failed: [], failure: null } })
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
    expect(rowsOf(s).map((r) => r.id)).toEqual(['new'])
  })

  it('drops a window part-way through its slices when another folder opens', async () => {
    const slow = gate<Response>()
    const old = Array.from({ length: 120 }, (_, i) => item(`o${String(i)}`, 200 - i))
    const api = fakeApi((call) =>
      (call.body as { from: string }).from === 'old' ? slow.promise : page([item('new', 1)]),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    const first = s.openFolder('old')
    const pause = holdNextYield()
    slow.release(page(old))
    // The first 50 items are checked; the window waits between slices.
    await pause.at
    await s.openFolder('new')
    pause.release()
    await first
    await tick()
    expect(rowsOf(s).map((r) => r.id)).toEqual(['new'])
    // It stopped at its next slice: its rows were never taken into the store.
    expect(s.view('o0')).toBeUndefined()
  })

  it('checks every item of a window, in slices, and refuses a window with a bad one', async () => {
    const good = Array.from({ length: 120 }, (_, i) => item(`i${String(i)}`, 200 - i))
    const bad = [...good.slice(0, 70), { ...good[70], version: 'two' }, ...good.slice(71)]
    const ok = useItems('w', () => 'BLD', fakeApi(() => page(good)).fetchFn)
    await ok.openFolder('bld')
    expect(rowsOf(ok)).toHaveLength(120)
    // The bad item is in the second slice of 50: the window is still refused as a whole.
    const refused = useItems('w2', () => 'BLD', fakeApi(() => page(bad as Item[])).fetchFn)
    await refused.openFolder('bld')
    expect(refused.list.value).toMatchObject({ state: 'error', error: { code: 'bad_response' } })
  })

  it('shows the empty state for a folder with no items', async () => {
    const { s } = await opened(() => json({}), [])
    expect(s.list.value).toMatchObject({ state: 'ready', data: { total: 0 } })
    expect(s.rowAt(0)).toBeUndefined()
  })

  it('fetches an item that is not in the list', async () => {
    const { s, calls } = await opened(() => json(withSeq(item('far', 99))), [])
    expect(await s.openItem('far')).toMatchObject({ state: 'ready', data: { seqId: 99 } })
    expect(calls.at(-1)?.path).toBe('/v1/workspaces/w/items/far')
    expect(s.view('far')?.seqId).toBe(99)
  })
})

describe('useItems: sorting', () => {
  type QueryBody = { from: string; offset: number; sort: unknown[] }
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
    expect(rowsOf(s).map((r) => r.id)).toEqual(['i2', 'i1'])
    sorted.release(page([item('i1', 1), item('i2', 2)]))
    await done
    expect(queries(api.calls).at(-1)).toMatchObject({
      offset: 0,
      count: true,
      sort: [{ attribute: 'stage', direction: 'desc' }],
    })
    expect(queries(api.calls).at(-1)).not.toHaveProperty('order')
    expect(rowsOf(s).map((r) => r.id)).toEqual(['i1', 'i2'])
    expect(s.list.value).toMatchObject({
      state: 'ready',
      data: { sorting: false, sort: { attribute: 'stage', direction: 'desc' } },
    })
  })

  it('reads the windows in view in the new order and drops the others', async () => {
    const many = (prefix: string) =>
      Array.from({ length: 200 }, (_, i) => item(`${prefix}${String(i)}`, 1000 - i))
    const api = fakeApi((call) => {
      const body = call.body as QueryBody
      const prefix = body.sort.length ? 's' : 'd'
      return page(body.offset === 0 ? many(prefix) : [item(`${prefix}-far`, 1)], 401)
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    s.showWindows(inView(400, 401, [400]))
    await tick()
    expect(s.rowAt(400)?.id).toBe('d-far')
    // The table is scrolled back to the top when the sort is asked for.
    s.showWindows(inView(0, 18, [0]))
    await s.setSort({ attribute: 'stage', direction: 'asc' })
    expect(queries(api.calls).at(-1)).toMatchObject({
      offset: 0,
      sort: [{ attribute: 'stage', direction: 'asc' }],
    })
    expect(s.rowAt(0)?.id).toBe('s0')
    // The window out of view held the old order: it is dropped and read again when needed.
    expect(s.rowAt(400)).toBeUndefined()
    s.showWindows(inView(400, 401, [400]))
    await tick()
    expect(queries(api.calls).at(-1)).toMatchObject({ offset: 400, sort: [{ attribute: 'stage' }] })
    expect(s.rowAt(400)?.id).toBe('s-far')
  })

  it('does not read windows while a new order is loading, and reads them in it after', async () => {
    const sorted = gate<Response>()
    const api = fakeApi((call) => {
      const body = call.body as QueryBody
      if (body.sort.length && body.offset === 0) return sorted.promise
      return page([item(body.sort.length ? 's1' : 'i1', 1)], 300)
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    const done = s.setSort({ attribute: 'stage', direction: 'asc' })
    s.showWindows(inView(195, 215, [0, 200]))
    expect(queries(api.calls).filter((b) => b.offset === 200)).toHaveLength(0)
    sorted.release(page([item('s0', 1)], 300))
    await done
    await tick()
    expect(queries(api.calls).filter((b) => b.offset === 200)).toEqual([
      expect.objectContaining({ sort: [{ attribute: 'stage', direction: 'asc' }] }),
    ])
  })

  it('drops a window read for the old order', async () => {
    const window = gate<Response>()
    const api = fakeApi((call) => {
      const body = call.body as QueryBody
      if (body.offset === 200 && !body.sort.length) return window.promise
      return body.sort.length ? page([item('s1', 1)]) : page([item('i1', 1)], 300)
    })
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    s.showWindows(inView(195, 215, [0, 200]))
    s.showWindows(inView(0, 18, [0]))
    await s.setSort({ attribute: 'stage', direction: 'asc' })
    window.release(page([item('old', 2)], 300))
    await tick()
    expect(rowsOf(s).map((r) => r.id)).toEqual(['s1'])
    expect(s.indexOf('old')).toBe(-1)
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
    expect(rowsOf(s).map((r) => r.id)).toEqual(['desc'])
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
        : page([item('i1', 1)]),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld')
    await s.setSort({ attribute: 'stage', direction: 'asc' })
    expect(s.sort.value).toBeNull()
    expect(s.list.value).toMatchObject({
      state: 'ready',
      data: { sorting: false, sort: null, total: 1 },
    })
    expect(rowsOf(s).map((r) => r.id)).toEqual(['i1'])
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
    expect(rowsOf(s).map((r) => r.id)).toEqual(['i1'])
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
    'The table can no longer be sorted by that column, so the items are shown newest first.'

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
    expect(rowsOf(s).map((r) => r.id)).toEqual(['i2'])
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
    // Nothing is shown newest first, so the notice does not say so (#85).
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

  describe('a window refused in a sorted order (#85)', () => {
    /** A folder sorted by stage with a second window, whose later queries `next` answers. */
    async function sortedWithMore(next: (body: QueryBody) => Response) {
      let sorted = false
      const api = fakeApi((call) => {
        if (!sorted) return page([item('i1', 1)], 300)
        return next(call.body as QueryBody)
      })
      const s = useItems('w', () => 'BLD', api.fetchFn)
      await s.openFolder('bld')
      await s.setSort(stage)
      sorted = true
      return { s, calls: api.calls }
    }

    it('shows the default order from the top, and says why', async () => {
      const { s, calls } = await sortedWithMore((body) =>
        body.sort.length ? refused() : page([item('i2', 2)], 300),
      )
      s.showWindows(inView(200, 220, [200]))
      await tick()
      await tick()
      expect(sorts(calls)).toEqual([[], [stage], [stage], []])
      expect(s.sort.value).toBeNull()
      expect(s.list.value).toMatchObject({ state: 'ready', data: { sort: null } })
      expect(rowsOf(s).map((r) => r.id)).toEqual(['i2'])
      expect(s.notice.value).toBe(notice)
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

    it('treats a 400 that does not name the sort as a failed window, which can be retried', async () => {
      const { s } = await sortedWithMore(() =>
        json({ error: 'invalid_request', message: 'offset: Too big' }, 400),
      )
      s.showWindows(inView(200, 220, [200]))
      await tick()
      expect(s.list.value).toMatchObject({
        state: 'ready',
        data: { sort: stage, failed: [200], failure: { status: 400 } },
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
    answer.release(json(withSeq(item('i1', 1, { title: 'New' }, 2))))
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
        return json(withSeq(item('i1', 1, body.values, version)))
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
    const id = rowsOf(s)[0]?.id ?? ''
    expect(rowsOf(s)).toHaveLength(2)
    expect(s.isCreating(id)).toBe(true)
    const body = calls.at(-1)?.body as { id: string; folderId: string; values: unknown }
    expect(body).toEqual({
      id,
      folderId: 'bld',
      values: { title: 'Fresh' },
      clientMutationId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
    })
    answer.release(json(withSeq(item(id, 2, { title: 'Fresh' })), 201))
    expect(await created).toMatchObject({ ok: true, item: { id, seqId: 2 } })
    expect(s.isCreating(id)).toBe(false)
    expect(rowsOf(s).map((r) => r.seqId)).toEqual([2, 1])
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
    expect(rowsOf(s).map((r) => r.id)).toEqual(['i1'])
    expect(s.notice.value).toContain('The item was not created')
  })

  it('does not send an edit for an item the server has not confirmed', async () => {
    const answer = gate<Response>()
    const { s, calls } = await opened(() => answer.promise, [item('i1', 1)])
    const created = s.create({ title: 'Fresh' })
    const id = rowsOf(s)[0]?.id ?? ''
    const sent = calls.length
    expect(await s.save(id, { title: 'Edited' })).toBe(false)
    expect(calls).toHaveLength(sent)
    expect(s.view(id)?.values).toEqual({ title: 'Fresh' })
    expect(s.notice.value).toContain('still being saved')
    answer.release(json(withSeq(item(id, 2, { title: 'Fresh' })), 201))
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
      json(
        withSeq({
          items: [linking(['t1', 't2', 't3'])],
          nextCursor: null,
          linked: { t1: { access: 'read', item: target }, t2: { access: 'none' } },
          linkedTruncated: false,
        }),
      ),
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
      json(
        withSeq({ items: [linking(['t3'])], nextCursor: null, linked: {}, linkedTruncated: true }),
      ),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    await s.openFolder('bld', ['blocks'])
    expect(s.linkState('t3')).toEqual({ access: 'unknown' })
  })

  it('reads uncovered linked items one by one; a 404 shows as no access', async () => {
    const api = fakeApi((call) => {
      if (call.path.endsWith('/query')) return json(withSeq({ items: [], nextCursor: null }))
      if (call.path.endsWith('/t1')) return json(withSeq(item('t1', 5)))
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
      if (call.path.endsWith('/query')) return json(withSeq({ items: [], nextCursor: null }))
      await held.promise
      return json(withSeq(item(call.path.split('/').at(-1) ?? '', 5)))
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
      call.path.endsWith('/query') ? list.promise : json(withSeq(item('t1', 5))),
    )
    const s = useItems('w', () => 'BLD', api.fetchFn)
    const opening = s.openFolder('bld', ['blocks'])
    s.resolveLinked(['t1'])
    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(0)
    list.release(
      json(
        withSeq({
          items: [item('i1', 1, { blocks: ['t1'] })],
          nextCursor: null,
          linked: { t1: { access: 'none' } },
          linkedTruncated: false,
        }),
      ),
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
    expect(rowsOf(s).map((r) => r.id)).toEqual(['i1'])
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
      json(
        withSeq({
          ...item('i1', 1, { blocks: ['t1', 't2', 't3'] }),
          linked: { t1: { access: 'read', item: target }, t2: { access: 'none' } },
          linkedTruncated: false,
        }),
      ),
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
      call.path.includes('expand')
        ? json(withSeq(item('i1', 1, {}, 1)))
        : json(withSeq(item('i1', 1, {}, 3))),
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
    const api = fakeApi((call) => json(withSeq(item(call.path.split('/').at(-1) ?? '', 5))))
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
      call.method === 'GET' ? json(withSeq(item('i1', 7, { title: 'Old' }, 2))) : handler(call),
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
    expect(rowsOf(s)).toEqual([])
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
    answer.release(json(withSeq(item('i1', 7, { title: 'New' }, 3))))
    await saved
    expect(await removed).toEqual({ ok: true })
    expect(calls.at(-1)?.path).toMatch(/^\/v1\/workspaces\/w\/items\/i1\?version=3&/)
  })
})

// From M3-03 the API adds the workspace `seq` to item, query and write responses (D58). The
// strict item schema would refuse it, so these must keep working, and the store keeps items
// without it (issue 168).
describe('useItems: responses carrying seq', () => {
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
    expect(rowsOf(s).map((r) => r.id)).toEqual(['i1'])
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
