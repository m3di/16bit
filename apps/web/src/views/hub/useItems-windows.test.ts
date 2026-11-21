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
