import type { Change, Filter, Item } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { createWorkspaceStore } from '../../sync/store.ts'
import { fakeApi, item, json, rowsOf, withSeq, type Call } from './fixtures.test-utils.ts'
import { filterAttributes, followSelected, useItems } from './useItems.ts'

// The folder's rows in windows by offset while changes arrive (D61): in the default order a
// change updates or shifts rows without a read; with an attribute sort or a filter, a change
// that may reorder them reads the windows in view again, debounced.

type QueryBody = {
  offset: number
  sort: { attribute: string; direction: string }[]
  order?: string
  where?: Filter
}

const page = (items: Item[], total = items.length) =>
  json(withSeq({ items, nextCursor: null, total }))
const changed = (it: Item, clientMutationId?: string): Change => ({
  seq: 20,
  hubId: it.hubId,
  itemId: it.id,
  item: it,
  ...(clientMutationId ? { clientMutationId } : {}),
})
const removed = (id: string): Change => ({ seq: 21, hubId: 'bld', itemId: id, item: null })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Long enough for the debounce of 5 ms below. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** Items 3, 2, 1 by number, newest first; `query` may answer the later reads differently. */
async function folder(
  query: (body: QueryBody, n: number) => Response | Promise<Response> = () =>
    page([item('i3', 3), item('i2', 2), item('i1', 1)]),
  other: (call: Call) => Response | Promise<Response> = () => json({}, 500),
) {
  const store = createWorkspaceStore('w')
  let n = 0
  const api = fakeApi((call) =>
    call.path.endsWith('/query') ? query(call.body as QueryBody, n++) : other(call),
  )
  const s = useItems('w', () => 'BLD', api.fetchFn, {
    store,
    hubId: () => 'bld',
    refetchDelay: 5,
  })
  await s.openFolder('bld')
  s.showWindows({ start: 0, end: 3, offsets: [0] })
  const reads = () => api.calls.filter((c) => c.path.endsWith('/query')).length
  return { s, store, calls: api.calls, reads }
}
const ids = (s: ReturnType<typeof useItems>) => rowsOf(s).map((r) => r.id)
const total = (s: ReturnType<typeof useItems>) =>
  s.list.value.state === 'ready' ? s.list.value.data.total : -1

describe('default order: item number, newest first (D61)', () => {
  it('updates an edited row in place, without a read', async () => {
    const { s, store, reads } = await folder()
    store.receive([changed(item('i1', 1, { title: 'Theirs' }, 2))])
    await settle()
    expect(ids(s)).toEqual(['i3', 'i2', 'i1'])
    expect(s.rowAt(2)?.values).toEqual({ title: 'Theirs' })
    expect(reads()).toBe(1)
  })

  it('puts a new item first and shifts the rest, without a read', async () => {
    const { s, store, reads } = await folder()
    store.receive([changed(item('i4', 4, { title: 'New' }, 1))])
    await settle()
    expect(ids(s)).toEqual(['i4', 'i3', 'i2', 'i1'])
    expect(total(s)).toBe(4)
    expect(reads()).toBe(1)
  })

  it('takes a deleted row out and moves the rest up, without a read', async () => {
    const { s, store, reads } = await folder()
    store.receive([removed('i2')])
    await settle()
    expect(ids(s)).toEqual(['i3', 'i1'])
    expect(s.indexOf('i1')).toBe(1)
    expect(total(s)).toBe(2)
    expect(reads()).toBe(1)
  })

  it('takes out a row moved to another folder', async () => {
    const { s, store } = await folder()
    store.receive([changed({ ...item('i2', 2, {}, 2), folderId: 'b' })])
    expect(ids(s)).toEqual(['i3', 'i1'])
    expect(total(s)).toBe(2)
  })

  it('reads the rows in view again for an item moved in among them', async () => {
    const { s, store, reads } = await folder((_body, n) =>
      n === 0
        ? page([item('i5', 5), item('i1', 1)])
        : page([item('i5', 5), item('i3', 3), item('i1', 1)]),
    )
    s.showWindows({ start: 0, end: 2, offsets: [0] })
    store.receive([changed(item('i3', 3, {}, 4))])
    await settle()
    expect(reads()).toBe(2)
    expect(ids(s)).toEqual(['i5', 'i3', 'i1'])
  })

  it('reads the rows in view again for a deleted item it has not loaded, which may be counted', async () => {
    const { store, reads } = await folder()
    store.receive([removed('far'), removed('farther')])
    await settle()
    // Two changes, one read.
    expect(reads()).toBe(2)
  })

  it('does not read again for the echo of its own delete', async () => {
    const { s, store, reads } = await folder(undefined, () => new Response(null, { status: 204 }))
    expect(await s.remove('i2')).toEqual({ ok: true })
    store.receive([removed('i2')])
    await settle()
    expect(ids(s)).toEqual(['i3', 'i1'])
    expect(reads()).toBe(1)
  })

  it('puts a refused delete back at its row', async () => {
    const { s } = await folder(undefined, () => json({ error: 'internal', message: 'Down' }, 500))
    const done = s.remove('i2')
    expect(ids(s)).toEqual(['i3', 'i1'])
    expect(await done).toMatchObject({ ok: false })
    expect(ids(s)).toEqual(['i3', 'i2', 'i1'])
    expect(total(s)).toBe(3)
  })

  it('puts its own new item first, and takes it out if the server refuses', async () => {
    const { s } = await folder(undefined, () => json({ error: 'internal', message: 'Down' }, 500))
    const created = s.create({ title: 'Mine' })
    expect(rowsOf(s)).toHaveLength(4)
    expect(s.rowAt(0)?.values).toEqual({ title: 'Mine' })
    await created
    expect(ids(s)).toEqual(['i3', 'i2', 'i1'])
  })
})

describe('an attribute sort or a filter (D61)', () => {
  const stage = { attribute: 'stage', direction: 'asc' } as const
  /** Sorted by stage: i1 (done), i2 (todo); a read after the first in the order `later` gives. */
  async function sorted(later: () => Item[] = () => [item('i2', 2, { stage: 'done' })]) {
    const t = await folder((body, n) => {
      if (!body.sort.length) return page([item('i2', 2), item('i1', 1)])
      if (n === 1) return page([item('i1', 1, { stage: 'done' }), item('i2', 2, { stage: 'todo' })])
      return page(later())
    })
    await t.s.setSort(stage)
    t.s.showWindows({ start: 0, end: 2, offsets: [0] })
    return t
  }

  it('reads the rows in view again after a change to the sorted attribute, once per burst', async () => {
    const { s, store, calls, reads } = await sorted(() => [
      item('i2', 2, { stage: 'done' }, 3),
      item('i1', 1, { stage: 'todo' }, 2),
    ])
    store.receive([changed(item('i1', 1, { stage: 'todo' }, 2))])
    store.receive([changed(item('i2', 2, { stage: 'done' }, 3))])
    await settle()
    expect(reads()).toBe(3)
    expect((calls.at(-1)?.body as QueryBody).sort).toEqual([stage])
    expect(ids(s)).toEqual(['i2', 'i1'])
  })

  it('does not read again for a change to another attribute', async () => {
    const { store, reads } = await sorted()
    store.receive([changed(item('i1', 1, { stage: 'done', title: 'Renamed' }, 2))])
    await settle()
    expect(reads()).toBe(2)
  })

  it('reads the rows in view again after a create', async () => {
    const { store, reads } = await sorted()
    store.receive([changed(item('i9', 9, { stage: 'todo' }))])
    await settle()
    expect(reads()).toBe(3)
  })

  it('reads them again after its own edit moves a row, without the feed', async () => {
    const { s, reads } = await folder(
      (body) =>
        body.sort.length
          ? page([item('i1', 1, { stage: 'done' }), item('i2', 2, { stage: 'todo' })])
          : page([item('i2', 2), item('i1', 1)]),
      () => json(withSeq(item('i1', 1, { stage: 'todo' }, 2))),
    )
    await s.setSort(stage)
    expect(await s.save('i1', { stage: 'todo' })).toBe(true)
    await settle()
    expect(reads()).toBe(3)
  })

  it('says where the rows in view were, so the screen can keep the selected row in view', async () => {
    const { s, store } = await sorted(() => [
      item('i2', 2, { stage: 'done' }, 3),
      item('i1', 1, { stage: 'todo' }, 2),
    ])
    store.receive([changed(item('i1', 1, { stage: 'todo' }, 2))])
    await settle()
    expect(s.reordered.value?.before).toEqual(
      new Map([
        ['i1', 0],
        ['i2', 1],
      ]),
    )
    expect(s.indexOf('i1')).toBe(1)
  })

  it('filters with `where`, and reads again when a filtered attribute changes', async () => {
    const where: Filter = { and: [{ attribute: 'stage', op: 'eq', value: 'todo' }] }
    expect(filterAttributes(where)).toEqual(['stage'])
    const { s, store, calls, reads } = await folder((body) =>
      body.where ? page([item('i2', 2, { stage: 'todo' })]) : page([item('i2', 2), item('i1', 1)]),
    )
    await s.setFilter(where)
    expect(calls.at(-1)?.body).toMatchObject({ where, order: 'number', offset: 0, count: true })
    expect(ids(s)).toEqual(['i2'])
    s.showWindows({ start: 0, end: 1, offsets: [0] })
    store.receive([changed(item('i2', 2, { stage: 'done' }, 2))])
    await settle()
    expect(reads()).toBe(3)
  })

  it('drops the rows out of view and reads them when scrolled to', async () => {
    const { s, store, reads } = await folder((body) =>
      body.offset === 0
        ? page(
            Array.from({ length: 200 }, (_, i) => item(`a${String(i)}`, 400 - i, { stage: 'x' })),
            300,
          )
        : page([item('b0', 1, { stage: 'x' })], 300),
    )
    await s.setSort(stage)
    s.showWindows({ start: 195, end: 210, offsets: [0, 200] })
    await tick()
    expect(s.rowAt(200)?.id).toBe('b0')
    s.showWindows({ start: 0, end: 18, offsets: [0] })
    store.receive([changed(item('a0', 400, { stage: 'y' }, 2))])
    await settle()
    expect(s.rowAt(200)).toBeUndefined()
    const before = reads()
    s.showWindows({ start: 195, end: 210, offsets: [0, 200] })
    await tick()
    expect(reads()).toBe(before + 1)
    expect(s.rowAt(200)?.id).toBe('b0')
  })
})

describe('followSelected (D61)', () => {
  const reorder = { before: new Map([['sel', 5]]) }
  const at = (index: number) => () => index
  const visible = (index: number) => index >= 0 && index < 10

  it('follows the selected row when it was in view and moved', () => {
    expect(followSelected(reorder, 'sel', at(40), visible)).toBe(40)
  })

  it('leaves the scroll alone when the row did not move, was out of view, or is not loaded', () => {
    expect(followSelected(reorder, 'sel', at(5), visible)).toBeNull()
    expect(followSelected(reorder, 'sel', at(40), () => false)).toBeNull()
    expect(followSelected(reorder, 'sel', at(-1), visible)).toBeNull()
    expect(followSelected(reorder, 'other', at(40), visible)).toBeNull()
    expect(followSelected(reorder, null, at(40), visible)).toBeNull()
    expect(followSelected(null, 'sel', at(40), visible)).toBeNull()
  })
})

/**
 * A folder of `n` items on a fake server, numbered 1 to `n`, read newest first in windows. A
 * read can be held: it is answered as the folder was when the request was made, on release.
 */
function server(n: number) {
  let items = Array.from({ length: n }, (_, i) => item(`i${String(n - i)}`, n - i))
  const holds = new Set<number>()
  const held: (() => void)[] = []
  const answer = (offset: number) => page(items.slice(offset, offset + 200), items.length)
  return {
    get items() {
      return items
    },
    query(body: QueryBody): Response | Promise<Response> {
      const response = answer(body.offset)
      if (!holds.delete(body.offset)) return response
      return new Promise((resolve) => {
        held.push(() => {
          resolve(response)
        })
      })
    },
    /** The next read of the window at `offset` waits for `release`. */
    hold(offset: number) {
      holds.add(offset)
    },
    release() {
      for (const go of held.splice(0)) go()
    },
    create(seqId: number, version = 1) {
      const created = item(`i${String(seqId)}`, seqId, {}, version)
      items = [created, ...items]
      return created
    },
    remove(id: string) {
      items = items.filter((i) => i.id !== id)
    },
  }
}

/** Every loaded row is the server's item at that row, none twice, and `total` is right. */
function expectInStep(s: ReturnType<typeof useItems>, items: readonly Item[]) {
  expect(total(s)).toBe(items.length)
  const seen = new Set<string>()
  for (let i = 0; i < items.length; i++) {
    const row = s.rowAt(i)
    if (!row) continue
    expect(row.id, `row ${String(i)}`).toBe(items[i]?.id)
    expect(seen.has(row.id), `${row.id} listed twice`).toBe(false)
    seen.add(row.id)
  }
}

/** Every row from `start` up to `end` is loaded. */
function expectLoaded(s: ReturnType<typeof useItems>, start: number, end: number) {
  for (let i = start; i < end; i++) expect(s.rowAt(i), `row ${String(i)}`).toBeDefined()
}

describe('several windows while rows shift (D61)', () => {
  /** 1,000 items; the reader has read window 0 and is at rows 400 to 420. */
  async function deep() {
    const folder = server(1000)
    const t = await (async () => {
      const store = createWorkspaceStore('w')
      const api = fakeApi((call) => folder.query(call.body as QueryBody))
      const s = useItems('w', () => 'BLD', api.fetchFn, {
        store,
        hubId: () => 'bld',
        refetchDelay: 5,
      })
      await s.openFolder('bld')
      const reads = () => api.calls.map((c) => (c.body as QueryBody).offset)
      return { s, store, reads }
    })()
    t.s.showWindows({ start: 400, end: 420, offsets: [400] })
    await tick()
    expectLoaded(t.s, 400, 420)
    return { folder, ...t }
  }

  it('puts a new item first even when its change already shows an edit (version 2)', async () => {
    const { s, store, folder } = await deep()
    // A create and an edit within one batch reach the feed as one change, at version 2 (D58).
    store.receive([changed(folder.create(1001, 2))])
    await settle()
    expect(s.rowAt(0)?.id).toBe('i1001')
    expectInStep(s, folder.items)
  })

  it('reads the rows in view again when a create moves an unread row into them', async () => {
    const { s, store, folder, reads } = await deep()
    store.receive([changed(folder.create(1001))])
    await settle()
    // Row 400 is now the old row 399, which was never read: window 400 is read again.
    expect(reads().filter((o) => o === 400)).toHaveLength(2)
    expectLoaded(s, 400, 420)
    expectInStep(s, folder.items)
  })

  it('reads the rows in view again when a delete moves an unread row into them', async () => {
    const { s, store, folder, reads } = await deep()
    // Row 10 goes: window 400 now ends with the old row 600, which was never read.
    folder.remove('i990')
    store.receive([removed('i990')])
    await settle()
    expect(reads().filter((o) => o === 400)).toHaveLength(2)
    expect(s.rowAt(599)?.id).toBe('i400')
    expectInStep(s, folder.items)
  })

  it('drops a window read that a create raced, and reads it again', async () => {
    const { s, store, folder, reads } = await deep()
    folder.hold(200)
    s.showWindows({ start: 190, end: 215, offsets: [0, 200] })
    await tick()
    // The read of window 200 is on its way when a create shifts every row by one.
    store.receive([changed(folder.create(1001))])
    folder.release()
    await settle()
    expect(reads().filter((o) => o === 200)).toHaveLength(2)
    expectLoaded(s, 190, 215)
    expectInStep(s, folder.items)
    // The row the stale read would have overwritten is still there.
    expect(s.indexOf('i801')).toBe(200)
  })

  it('reads the view again when a create raced a refetch', async () => {
    const { s, store, folder, reads } = await deep()
    // A delete of an item not loaded makes the view read its windows again.
    folder.remove('i10')
    folder.hold(400)
    store.receive([removed('i10')])
    await settle()
    // That read is on its way when a create arrives; it answers without the new item.
    store.receive([changed(folder.create(1001))])
    folder.release()
    await settle()
    await settle()
    // Read once on opening the view, once for the delete, and again because the create raced it.
    expect(reads().filter((o) => o === 400)).toHaveLength(3)
    expectLoaded(s, 400, 420)
    expectInStep(s, folder.items)
  })

  it('reads the view again when a create raced a new sort', async () => {
    const { s, store, folder, reads } = await deep()
    folder.hold(400)
    const sorting = s.setSort({ attribute: 'stage', direction: 'asc' })
    await tick()
    store.receive([changed(folder.create(1001))])
    folder.release()
    await sorting
    const before = reads().length
    await settle()
    // The sorted read predates the create, so the view is read again in the new order.
    expect(reads().length).toBeGreaterThan(before)
    expectLoaded(s, 400, 420)
    expectInStep(s, folder.items)
  })

  it('does not read again for a delete in another hub', async () => {
    const { store, reads } = await deep()
    const before = reads().length
    store.receive([{ seq: 30, hubId: 'other', itemId: 'x1', item: null }])
    await settle()
    expect(reads()).toHaveLength(before)
  })
})
