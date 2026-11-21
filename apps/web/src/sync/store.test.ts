import type { Item } from '@16bit/core'
import { describe, expect, it, vi } from 'vitest'
import { isReactive, watchEffect } from 'vue'
import { item } from '../views/hub/fixtures.test-utils.ts'
import { fakeFeed, liveStore } from './fake-feed.test-utils.ts'
import { FEED_CLOSE_CODES } from '@16bit/core'
import { setUnauthorizedHandler } from '../api/client.ts'
import type { FeedHandlers } from './feed.ts'
import { createWorkspaceStore, resetWorkspaceStores, workspaceStore } from './store.ts'

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

  it('applies changes and tombstones deletions, the echo of a pending write included', () => {
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
      hubIds: ['bld'],
      changes: [
        { seq: 4, hubId: 'bld', itemId: 'i1', item: at('i1', 2, 'Mine'), clientMutationId: MINE },
        { seq: 5, hubId: 'bld', itemId: 'i2', item: null },
      ],
    })
    expect(store.get('i1')?.version).toBe(2)
    expect(store.isDeleted('i2')).toBe(true)
    expect(events).toHaveBeenCalledTimes(2)
    // The pending edit still shows over the echoed copy until its response confirms it.
    expect(store.view('i1')?.values['title']).toBe('Mine')
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

describe('workspace store: hubs that are not live', () => {
  it('reports offline while a held hub was refused, until a message names it again', () => {
    const { store, socket } = liveStore()
    store.hold('a')
    store.hold('b')
    store.noteRead('a', 1)
    store.noteRead('b', 1)
    socket()?.open()
    socket()?.push({ type: 'changes', seq: 1, hubIds: ['a'], changes: [] })
    socket()?.push({
      type: 'error',
      code: 'too_many_subscriptions',
      message: 'Too many',
      hubId: 'b',
    })
    expect(store.isLive('b')).toBe(false)
    expect(store.status.value).toBe('offline')
    // The next read subscribes it again; its answer makes it live.
    store.noteRead('b', 2)
    socket()?.push({ type: 'changes', seq: 2, hubIds: ['b'], changes: [] })
    expect(store.isLive('b')).toBe(true)
    expect(store.status.value).toBe('online')
  })

  it('stops reporting a hub nobody holds', () => {
    const { store, socket } = liveStore()
    const release = store.hold('a')
    store.hold('b')
    store.noteRead('b', 1)
    socket()?.open()
    store.markBehind('a')
    expect(store.status.value).toBe('offline')
    release()
    expect(store.status.value).toBe('online')
  })
})

describe('workspace store: the session ends (4401)', () => {
  it('drops every store, sends the reader to sign in, and a new store is live again', () => {
    const unauthorized = vi.fn()
    const stop = setUnauthorizedHandler(unauthorized)
    try {
      const feeds: ReturnType<typeof fakeFeed>[] = []
      const make = (_w: string, handlers: FeedHandlers) => {
        const made = fakeFeed(handlers)
        feeds.push(made)
        return made.feed
      }
      const first = workspaceStore('w', make)
      first.hold('bld')
      first.noteRead('bld', 5)
      first.apply(at('i1', 1))
      feeds[0]?.socket()?.open()
      feeds[0]?.socket()?.drop(FEED_CLOSE_CODES.credentialsEnded)
      expect(unauthorized).toHaveBeenCalledTimes(1)
      expect(first.isLive('bld')).toBe(false)

      // After signing in again: a fresh store, with nothing from before, and a live feed.
      const second = workspaceStore('w', make)
      expect(second).not.toBe(first)
      expect(second.get('i1')).toBeUndefined()
      second.hold('bld')
      second.noteRead('bld', 9)
      feeds[1]?.socket()?.open()
      expect(feeds[1]?.socket()?.sent).toEqual([{ type: 'subscribe', hubId: 'bld', after: 9 }])
      expect(second.status.value).toBe('online')
    } finally {
      stop()
      resetWorkspaceStores()
    }
  })
})
