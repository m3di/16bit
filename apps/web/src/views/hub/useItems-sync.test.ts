import type { Change, Item } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { liveStore } from '../../sync/fake-feed.test-utils.ts'
import { fakeApi, item, json, withSeq, type Call } from './fixtures.test-utils.ts'
import { useItems } from './useItems.ts'

// The folder list, the panel and the item page on the workspace store with a live feed
// (D58, D59, D60), the feed running on a fake socket.

const page = (items: Item[], seq: number, nextCursor: string | null = null) =>
  json({ items, nextCursor, seq })

/** A promise that resolves when `release` is called, to hold a request open. */
function gate<T>() {
  let release: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

type Handler = (call: Call) => Response | Promise<Response>

/** A hub page's items over a live store; `query` answers the folder query. */
async function live(query: Handler, other: Handler = () => json({}, 500)) {
  const feed = liveStore()
  const api = fakeApi((call) => (call.path.endsWith('/query') ? query(call) : other(call)))
  const s = useItems('w', () => 'BLD', api.fetchFn, { store: feed.store, hubId: () => 'bld' })
  await s.openFolder('bld')
  feed.socket()?.open()
  return { s, calls: api.calls, ...feed }
}

const changes = (seq: number, list: Change[]) => ({
  type: 'changes' as const,
  seq,
  hubIds: ['bld'],
  changes: list,
})
const changed = (it: Item, seq: number, clientMutationId?: string): Change => ({
  seq,
  hubId: it.hubId,
  itemId: it.id,
  item: it,
  ...(clientMutationId ? { clientMutationId } : {}),
})
const removed = (id: string, seq: number): Change => ({ seq, hubId: 'bld', itemId: id, item: null })
const ids = (s: ReturnType<typeof useItems>) => s.rows.value.map((r) => r.id)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('live reads (D58)', () => {
  it('subscribes the hub with the seq the folder query came with', async () => {
    const { socket } = await live(() => page([item('i1', 1)], 40))
    expect(socket()?.sent).toEqual([{ type: 'subscribe', hubId: 'bld', after: 40 }])
  })

  it('subscribes an empty folder too, by the hub it belongs to', async () => {
    const { socket } = await live(() => page([], 7))
    expect(socket()?.sent).toEqual([{ type: 'subscribe', hubId: 'bld', after: 7 }])
  })

  it('subscribes an item opened by ID with the seq of its read', async () => {
    const feed = liveStore()
    const api = fakeApi(() => json({ ...item('i9', 9), seq: 55 }))
    const s = useItems('w', () => 'BLD', api.fetchFn, { store: feed.store, list: false })
    await s.openItem('i9')
    feed.socket()?.open()
    expect(feed.socket()?.sent).toEqual([{ type: 'subscribe', hubId: 'bld', after: 55 }])
  })

  it('restarts the subscription from an older read, so nothing between them is missed', async () => {
    const reads = [page([item('i1', 1)], 40, 'c1'), page([item('i2', 2)], 31)]
    const { s, socket } = await live(() => reads.shift() ?? page([], 99))
    await s.loadMore()
    expect(socket()?.sent).toEqual([
      { type: 'subscribe', hubId: 'bld', after: 40 },
      { type: 'subscribe', hubId: 'bld', after: 31 },
    ])
  })

  it('lets the hub go when the view is disposed', async () => {
    const { s, socket, store } = await live(() => page([], 3))
    s.dispose()
    expect(socket()?.sent.at(-1)).toEqual({ type: 'unsubscribe', hubId: 'bld' })
    expect(store.isLive('bld')).toBe(false)
  })
})

describe('applying changes', () => {
  it('updates a row in place', async () => {
    const { s, socket } = await live(() => page([item('i2', 2), item('i1', 1)], 10))
    socket()?.push(changes(11, [changed(item('i1', 1, { title: 'Theirs' }, 2), 11)]))
    expect(ids(s)).toEqual(['i2', 'i1'])
    expect(s.view('i1')).toMatchObject({ version: 2, values: { title: 'Theirs' } })
  })

  it('puts an item new to the open folder on top, and ignores other folders', async () => {
    const { s, socket } = await live(() => page([item('i1', 1)], 10))
    socket()?.push(
      changes(12, [
        changed(item('n1', 5, { title: 'New' }), 11),
        changed({ ...item('o1', 6), folderId: 'b' }, 12),
      ]),
    )
    expect(ids(s)).toEqual(['n1', 'i1'])
  })

  it('removes a deleted row', async () => {
    const { s, socket } = await live(() => page([item('i2', 2), item('i1', 1)], 10))
    socket()?.push(changes(11, [removed('i1', 11)]))
    expect(ids(s)).toEqual(['i2'])
  })

  it('never lets a stale version or a late event overwrite a newer item', async () => {
    const { s, socket } = await live(
      () => page([item('i1', 1, { title: 'A' }, 1)], 10),
      () => json(withSeq(item('i1', 1, { title: 'Mine' }, 3), 13)),
    )
    expect(await s.save('i1', { title: 'Mine' })).toBe(true)
    // Events for versions 2 and 3 arrive after the response that gave version 3.
    socket()?.push(
      changes(13, [
        changed(item('i1', 1, { title: 'Between' }, 2), 12),
        changed(item('i1', 1, { title: 'Older' }, 1), 13),
      ]),
    )
    expect(s.view('i1')).toMatchObject({ version: 3, values: { title: 'Mine' } })
  })

  it('does not take an older copy from a slower list read', async () => {
    const reads = [page([item('i1', 1, { title: 'Old' }, 1)], 10)]
    const { s, socket } = await live(() => reads.shift() ?? page([item('i1', 1, {}, 1)], 9))
    socket()?.push(changes(11, [changed(item('i1', 1, { title: 'New' }, 2), 11)]))
    await s.openFolder('bld')
    expect(s.view('i1')).toMatchObject({ version: 2, values: { title: 'New' } })
  })

  it('keeps a deleted row from coming back with a stale read (tombstone)', async () => {
    const reads = [page([item('i2', 2), item('i1', 1)], 10)]
    const { s, socket } = await live(
      () => reads.shift() ?? page([item('i2', 2), item('i1', 1)], 9),
      () => json(withSeq(item('i1', 1), 12)),
    )
    socket()?.push(changes(11, [removed('i1', 11)]))
    await s.openFolder('bld')
    expect(ids(s)).toEqual(['i2'])
    expect(await s.openItem('i1')).toMatchObject({ state: 'error', error: { status: 404 } })
  })
})

describe('own writes and their echo (D59)', () => {
  const mutationOf = (call: Call | undefined) =>
    (call?.body as { clientMutationId?: string } | undefined)?.clientMutationId ?? ''

  it('sends a mutation ID with every write', async () => {
    const { s, calls } = await live(
      () => page([item('i1', 1)], 10),
      (call) =>
        call.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : json(withSeq(item('i1', 1, {}, 2), 11)),
    )
    await s.save('i1', { title: 'x' })
    await s.remove('i1')
    const [patch, del] = calls.filter((c) => c.method === 'PATCH' || c.method === 'DELETE')
    expect(mutationOf(patch)).toMatch(/^[0-9a-f-]{36}$/)
    expect(del?.path).toMatch(/clientMutationId=[0-9a-f-]{36}$/)
  })

  it('does not apply an edit twice when its echo comes before the response', async () => {
    const answer = gate<Response>()
    const { s, socket, calls } = await live(
      () => page([item('i1', 1, { title: 'Old', points: 1 })], 10),
      () => answer.promise,
    )
    const saved = s.save('i1', { title: 'Mine' })
    await flush()
    const mine = item('i1', 1, { title: 'Mine', points: 1 }, 2)
    socket()?.push(changes(11, [changed(mine, 11, mutationOf(calls.at(-1)))]))
    expect(s.view('i1')).toMatchObject({ version: 2, values: { title: 'Mine' } })
    expect(s.isSaving('i1')).toBe(true)
    answer.release(json({ ...mine, seq: 11 }))
    expect(await saved).toBe(true)
    expect(s.view('i1')).toMatchObject({ version: 2, values: { title: 'Mine' } })
    expect(s.isSaving('i1')).toBe(false)
  })

  it('does not list a new item twice when its echo comes before the response', async () => {
    const answer = gate<Response>()
    const { s, socket, calls } = await live(
      () => page([item('i1', 1)], 10),
      () => answer.promise,
    )
    const created = s.create({ title: 'Fresh' })
    const id = ids(s)[0] ?? ''
    const fresh = { ...item(id, 2, { title: 'Fresh' }) }
    socket()?.push(changes(11, [changed(fresh, 11, mutationOf(calls.at(-1)))]))
    expect(ids(s)).toEqual([id, 'i1'])
    expect(s.isCreating(id)).toBe(true)
    answer.release(json({ ...fresh, seq: 11 }, 201))
    expect(await created).toMatchObject({ ok: true, item: { id, seqId: 2 } })
    expect(ids(s)).toEqual([id, 'i1'])
    expect(s.isCreating(id)).toBe(false)
  })

  it('hides a deleted row at once and brings it back when the server refuses', async () => {
    const answer = gate<Response>()
    const { s } = await live(
      () => page([item('i2', 2), item('i1', 1)], 10),
      () => answer.promise,
    )
    const done = s.remove('i1')
    expect(ids(s)).toEqual(['i2'])
    answer.release(json({ error: 'internal', message: 'Database down' }, 500))
    expect(await done).toEqual({ ok: false, message: 'BLD-1 was not deleted. Database down.' })
    expect(ids(s)).toEqual(['i2', 'i1'])
  })

  it('confirms a write made while the socket is down by its HTTP response', async () => {
    const { s, socket, store } = await live(
      () => page([item('i1', 1, { title: 'Old' })], 10),
      () => json({ ...item('i1', 1, { title: 'Offline' }, 2), seq: 12 }),
    )
    socket()?.drop()
    expect(store.status.value).toBe('offline')
    expect(await s.save('i1', { title: 'Offline' })).toBe(true)
    expect(s.view('i1')).toMatchObject({ version: 2, values: { title: 'Offline' } })
    expect(s.isSaving('i1')).toBe(false)
    expect(s.notice.value).toBeNull()
  })
})

describe('reconnect and resync', () => {
  it('resumes after a drop from the last high-water seq', async () => {
    const { socket, sockets, clock } = await live(() => page([item('i1', 1)], 10))
    socket()?.push(changes(18, []))
    socket()?.drop()
    clock.advance(1000)
    expect(sockets).toHaveLength(2)
    socket()?.open()
    expect(socket()?.sent).toEqual([{ type: 'subscribe', hubId: 'bld', after: 18 }])
  })

  it('reloads the list on resync, keeping the rows, and subscribes from the new read', async () => {
    const second = gate<Response>()
    const reads: (Response | Promise<Response>)[] = [page([item('i1', 1)], 10), second.promise]
    const { s, socket } = await live(() => reads.shift() ?? page([], 0))
    socket()?.push({ type: 'resync', hubId: 'bld' })
    expect(ids(s)).toEqual(['i1'])
    expect(s.list.value.state).toBe('ready')
    second.release(page([item('i3', 3, {}, 4), item('i1', 1, { title: 'Later' }, 5)], 2000))
    await flush()
    expect(ids(s)).toEqual(['i3', 'i1'])
    expect(s.view('i1')).toMatchObject({ version: 5 })
    expect(socket()?.sent.at(-1)).toEqual({ type: 'subscribe', hubId: 'bld', after: 2000 })
  })

  it('reads an item opened by ID again on resync', async () => {
    const feed = liveStore()
    const reads = [json({ ...item('i9', 9), seq: 5 }), json({ ...item('i9', 9, {}, 3), seq: 1500 })]
    const api = fakeApi(() => reads.shift() ?? json({}, 500))
    const s = useItems('w', () => 'BLD', api.fetchFn, { store: feed.store, list: false })
    await s.openItem('i9')
    feed.socket()?.open()
    feed.socket()?.push({ type: 'resync', hubId: 'bld' })
    await flush()
    expect(s.view('i9')?.version).toBe(3)
    expect(feed.socket()?.sent.at(-1)).toEqual({ type: 'subscribe', hubId: 'bld', after: 1500 })
  })
})
