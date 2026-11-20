import type { Item } from '@16bit/core'
import { describe, expect, it, vi } from 'vitest'
import { isReactive, watchEffect } from 'vue'
import { item } from '../views/hub/fixtures.test-utils.ts'
import { liveStore } from './fake-feed.test-utils.ts'
import { createWorkspaceStore } from './store.ts'

const MINE = '6f1c1f9e-8f53-4a4e-9a57-1d2b8c3e4f50'

const at = (id: string, version: number, title = `v${String(version)}`): Item =>
  item(id, 1, { title }, version)

describe('workspace store: applying', () => {
  it('keeps an item only if its version is newer than the one held', () => {
    const store = createWorkspaceStore('w')
    expect(store.apply(at('i1', 2))).toBe(true)
    expect(store.apply(at('i1', 1))).toBe(false)
    expect(store.apply(at('i1', 2, 'other'))).toBe(false)
    expect(store.get('i1')?.values['title']).toBe('v2')
    expect(store.apply(at('i1', 3))).toBe(true)
    expect(store.get('i1')?.version).toBe(3)
  })

  it('holds frozen, unreactive items and replaces them', () => {
    const store = createWorkspaceStore('w')
    store.apply(at('i1', 1))
    const first = store.get('i1')
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first?.values)).toBe(true)
    expect(isReactive(first)).toBe(false)
    store.apply(at('i1', 2))
    expect(store.get('i1')).not.toBe(first)
    expect(first?.version).toBe(1)
  })

  it('never brings back a deleted item', () => {
    const store = createWorkspaceStore('w')
    store.apply(at('i1', 1))
    store.tombstone('i1')
    expect(store.apply(at('i1', 9))).toBe(false)
    expect(store.get('i1')).toBeUndefined()
    expect(store.view('i1')).toBeUndefined()
    expect(store.isDeleted('i1')).toBe(true)
  })

  it('tells views when an item changes', () => {
    const store = createWorkspaceStore('w')
    const seen: (number | undefined)[] = []
    watchEffect(() => seen.push(store.get('i1')?.version), { flush: 'sync' })
    store.apply(at('i1', 1))
    store.apply(at('i1', 1))
    store.apply(at('i1', 2))
    store.tombstone('i1')
    expect(seen).toEqual([undefined, 1, 2, undefined])
  })
})

describe('workspace store: pending writes', () => {
  it('shows patches over the server copy and drops them one by one', () => {
    const store = createWorkspaceStore('w')
    store.apply(item('i1', 1, { title: 'Old', points: 1 }))
    store.addPending('i1', { kind: 'patch', mutationId: 'm1', values: { title: 'A' } })
    store.addPending('i1', { kind: 'patch', mutationId: 'm2', values: { points: 2 } })
    expect(store.view('i1')?.values).toEqual({ title: 'A', points: 2 })
    expect(store.get('i1')?.values).toEqual({ title: 'Old', points: 1 })
    store.dropPending('i1', 'm1')
    expect(store.view('i1')?.values).toEqual({ title: 'Old', points: 2 })
    expect(store.isSaving('i1')).toBe(true)
    store.dropPendingKind('i1', 'patch')
    expect(store.isSaving('i1')).toBe(false)
  })

  it('shows a pending create until the server copy arrives, and hides a pending delete', () => {
    const store = createWorkspaceStore('w')
    store.addPending('n', { kind: 'create', mutationId: 'm1', item: at('n', 1, 'Draft') })
    expect(store.isCreating('n')).toBe(true)
    expect(store.view('n')?.values['title']).toBe('Draft')
    store.apply(at('n', 1, 'Saved'))
    expect(store.view('n')?.values['title']).toBe('Saved')
    store.dropPending('n', 'm1')
    store.addPending('n', { kind: 'delete', mutationId: 'm2' })
    expect(store.view('n')).toBeUndefined()
    store.dropPending('n', 'm2')
    expect(store.view('n')?.values['title']).toBe('Saved')
  })
})

describe('workspace store: the feed', () => {
  it('subscribes a held hub with the seq of a read, and nothing without one', () => {
    const { store, socket } = liveStore()
    store.noteRead('bld', 10)
    expect(socket()).toBeUndefined()
    const release = store.hold('bld')
    store.noteRead('bld', undefined)
    expect(socket()).toBeUndefined()
    store.noteRead('bld', 10)
    socket()?.open()
    expect(socket()?.sent).toEqual([{ type: 'subscribe', hubId: 'bld', after: 10 }])
    expect(store.isLive('bld')).toBe(true)
    release()
    expect(store.isLive('bld')).toBe(false)
    expect(socket()?.sent.at(-1)).toEqual({ type: 'unsubscribe', hubId: 'bld' })
  })

  it('keeps a hub live while any view holds it', () => {
    const { store, socket } = liveStore()
    const a = store.hold('bld')
    const b = store.hold('bld')
    store.noteRead('bld', 1)
    socket()?.open()
    a()
    a()
    expect(store.isLive('bld')).toBe(true)
    b()
    expect(store.isLive('bld')).toBe(false)
  })

  it('applies changes, tombstones deletions, and marks the echo of a pending write', () => {
    const { store, socket } = liveStore()
    store.hold('bld')
    store.noteRead('bld', 1)
    socket()?.open()
    store.apply(at('i1', 1))
    store.apply(at('i2', 1))
    store.addPending('i1', { kind: 'patch', mutationId: MINE, values: { title: 'Mine' } })
    const events = vi.fn()
    store.on('change', events)
    socket()?.push({
      type: 'changes',
      seq: 5,
      changes: [
        { seq: 4, hubId: 'bld', itemId: 'i1', item: at('i1', 2, 'Mine'), clientMutationId: MINE },
        { seq: 5, hubId: 'bld', itemId: 'i2', item: null },
      ],
    })
    expect(store.get('i1')?.version).toBe(2)
    expect(store.isDeleted('i2')).toBe(true)
    expect(events.mock.calls.map(([e]) => (e as { own: boolean }).own)).toEqual([true, false])
  })

  it('records a lost hub until a view holds it afresh', () => {
    const { store, socket } = liveStore()
    const release = store.hold('bld')
    store.noteRead('bld', 1)
    socket()?.open()
    socket()?.push({ type: 'access_lost', hubId: 'bld' })
    expect(store.isLost('bld')).toBe(true)
    expect(store.isLive('bld')).toBe(false)
    // No read subscribes a lost hub again on this page.
    store.noteRead('bld', 2)
    expect(store.isLive('bld')).toBe(false)
    release()
    store.hold('bld')
    expect(store.isLost('bld')).toBe(false)
  })

  it('reports the connection state', () => {
    const { store, socket } = liveStore()
    expect(store.status.value).toBe('idle')
    store.hold('bld')
    store.noteRead('bld', 1)
    expect(store.status.value).toBe('connecting')
    socket()?.open()
    expect(store.status.value).toBe('online')
    socket()?.drop()
    expect(store.status.value).toBe('offline')
  })
})
