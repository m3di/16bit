import type { Change, FeedErrorCode, Item, ItemValues } from '@16bit/core'
import { computed, shallowReactive, type ComputedRef } from 'vue'
import { createFeed, feedUrl, type FeedClient, type FeedStatus } from './feed.ts'

// One normalised store per workspace and tab (D60): server items by ID, frozen and replaced,
// never mutated, under a pending layer of the reader's own writes that have not been confirmed.
// Every item that reaches it, from a read, a write response or the feed, goes through `apply`,
// which keeps an item only if its version is newer than the one held and never brings back an
// item that was deleted (D58).

/** A write of the reader's own, shown before the server confirms it (D59). */
export type PendingWrite =
  | { kind: 'create'; mutationId: string; item: Readonly<Item> }
  | { kind: 'patch'; mutationId: string; values: ItemValues }
  | { kind: 'delete'; mutationId: string }

/** One change from the feed, after the store took it in. */
export interface AppliedChange {
  change: Change
  /** The change carries the ID of a write of the reader's own that is still pending (D59). */
  own: boolean
}

export interface StoreEvents {
  change: (event: AppliedChange) => void
  hub: (hubId: string, version: number) => void
  accessLost: (hubId: string) => void
  resync: (hubId: string) => void
  refused: (hubId: string, code: FeedErrorCode) => void
}

type Listeners = { [K in keyof StoreEvents]: Set<StoreEvents[K]> }

const freeze = (item: Item): Readonly<Item> =>
  Object.isFrozen(item)
    ? item
    : Object.freeze({ ...item, values: Object.freeze({ ...item.values }) })

export interface WorkspaceStore {
  workspaceId: string
  /** The feed's connection state, `idle` when there is no feed. */
  status: ComputedRef<FeedStatus>
  /** The server's copy, or `undefined` when unknown or deleted. */
  get(id: string): Readonly<Item> | undefined
  /** The item as shown: the server copy with pending writes applied. Hidden while being deleted. */
  view(id: string): Readonly<Item> | undefined
  /** Keeps `item` if it is newer than the copy held and not deleted. Returns whether it was kept. */
  apply(item: Item): boolean
  /** Records that an item is gone; nothing brings it back (D58). */
  tombstone(id: string): void
  isDeleted(id: string): boolean
  pending(id: string): readonly PendingWrite[]
  addPending(id: string, write: PendingWrite): void
  /** Drops one pending write, by its mutation ID. */
  dropPending(id: string, mutationId: string): void
  /** Drops pending writes of one kind (a 409 makes every queued patch stale). */
  dropPendingKind(id: string, kind: PendingWrite['kind']): void
  isCreating(id: string): boolean
  isSaving(id: string): boolean
  /**
   * Keeps a hub live while a view shows it. The first hold clears an earlier `access_lost`, so a
   * page opened again reads afresh. Returns the release.
   */
  hold(hubId: string): () => void
  /** A read of the hub at `seq` (D58): subscribes after it, if the hub is held and has a feed. */
  noteRead(hubId: string, seq: number | undefined): void
  /** The hub is subscribed, so held copies are kept up to date. */
  isLive(hubId: string): boolean
  /** The feed said the reader lost access to the hub (or the subscription was refused as missing). */
  isLost(hubId: string): boolean
  on<K extends keyof StoreEvents>(event: K, fn: StoreEvents[K]): () => void
  /** Feeds a `changes` message in, as the feed client does; exposed for tests. */
  receive(changes: readonly Change[]): void
  dispose(): void
}

export function createWorkspaceStore(
  workspaceId: string,
  makeFeed: ((handlers: Parameters<typeof createFeed>[1]) => FeedClient) | null = null,
): WorkspaceStore {
  const server = shallowReactive(new Map<string, Readonly<Item>>())
  const deleted = shallowReactive(new Set<string>())
  const pendingWrites = shallowReactive(new Map<string, readonly PendingWrite[]>())
  const lost = shallowReactive(new Set<string>())
  const holds = new Map<string, number>()
  const listeners: Listeners = {
    change: new Set(),
    hub: new Set(),
    accessLost: new Set(),
    resync: new Set(),
    refused: new Set(),
  }

  function apply(item: Item): boolean {
    if (deleted.has(item.id)) return false
    const held = server.get(item.id)
    if (held && held.version >= item.version) return false
    server.set(item.id, freeze(item))
    return true
  }

  function tombstone(id: string) {
    deleted.add(id)
    server.delete(id)
  }

  const pending = (id: string) => pendingWrites.get(id) ?? []

  function view(id: string): Readonly<Item> | undefined {
    const writes = pending(id)
    if (writes.length === 0) return server.get(id)
    if (writes.some((w) => w.kind === 'delete')) return undefined
    let item = server.get(id) ?? writes.find((w) => w.kind === 'create')?.item
    if (!item) return undefined
    const patches = writes.filter((w) => w.kind === 'patch')
    if (patches.length > 0) {
      const values = patches.reduce<ItemValues>((acc, w) => ({ ...acc, ...w.values }), item.values)
      item = Object.freeze({ ...item, values })
    }
    return item
  }

  function setPending(id: string, writes: readonly PendingWrite[]) {
    if (writes.length === 0) pendingWrites.delete(id)
    else pendingWrites.set(id, Object.freeze([...writes]))
  }

  const ownIds = () => {
    const ids = new Set<string>()
    for (const writes of pendingWrites.values()) for (const w of writes) ids.add(w.mutationId)
    return ids
  }

  function receive(changes: readonly Change[]) {
    const own = changes.some((c) => c.clientMutationId) ? ownIds() : new Set<string>()
    for (const change of changes) {
      // The item as it is now, or gone (D58). Applied like any read: versions and tombstones
      // decide, so the echo of the reader's own write changes nothing it has not already shown.
      if (change.item) apply(change.item)
      else tombstone(change.itemId)
      const event: AppliedChange = {
        change,
        own: change.clientMutationId !== undefined && own.has(change.clientMutationId),
      }
      for (const fn of listeners.change) fn(event)
    }
  }

  const feed = makeFeed
    ? makeFeed({
        changes: (message) => {
          receive(message.changes)
        },
        hub: (hubId, version) => {
          for (const fn of listeners.hub) fn(hubId, version)
        },
        accessLost: (hubId) => {
          lost.add(hubId)
          for (const fn of listeners.accessLost) fn(hubId)
        },
        resync: (hubId) => {
          for (const fn of listeners.resync) fn(hubId)
        },
        refused: (hubId, code) => {
          for (const fn of listeners.refused) fn(hubId, code)
        },
      })
    : null

  return {
    workspaceId,
    status: computed(() => feed?.status.value ?? 'idle'),
    get: (id) => server.get(id),
    view,
    apply,
    tombstone,
    isDeleted: (id) => deleted.has(id),
    pending,
    addPending: (id, write) => {
      setPending(id, [...pending(id), write])
    },
    dropPending: (id, mutationId) => {
      setPending(
        id,
        pending(id).filter((w) => w.mutationId !== mutationId),
      )
    },
    dropPendingKind: (id, kind) => {
      setPending(
        id,
        pending(id).filter((w) => w.kind !== kind),
      )
    },
    isCreating: (id) => pending(id).some((w) => w.kind === 'create'),
    isSaving: (id) => pending(id).length > 0,
    hold(hubId) {
      const count = holds.get(hubId) ?? 0
      if (count === 0) lost.delete(hubId)
      holds.set(hubId, count + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const left = (holds.get(hubId) ?? 1) - 1
        if (left > 0) {
          holds.set(hubId, left)
          return
        }
        holds.delete(hubId)
        feed?.untrack(hubId)
      }
    },
    noteRead(hubId, seq) {
      // No `seq` (an API from before M3-03) means nothing to subscribe from: no live updates.
      if (seq === undefined || !feed || !holds.has(hubId) || lost.has(hubId)) return
      feed.track(hubId, seq)
    },
    isLive: (hubId) => feed?.isTracked(hubId) ?? false,
    isLost: (hubId) => lost.has(hubId),
    on(event, fn) {
      const set = listeners[event] as Set<typeof fn>
      set.add(fn)
      return () => set.delete(fn)
    },
    receive,
    dispose: () => feed?.close(),
  }
}

const stores = new Map<string, WorkspaceStore>()

/** The tab's store for a workspace, with a feed on the page's origin when there is a browser. */
export function workspaceStore(workspaceId: string): WorkspaceStore {
  let store = stores.get(workspaceId)
  if (!store) {
    const browser = typeof WebSocket !== 'undefined' && typeof location !== 'undefined'
    store = createWorkspaceStore(
      workspaceId,
      browser ? (handlers) => createFeed(feedUrl(workspaceId, location), handlers) : null,
    )
    stores.set(workspaceId, store)
  }
  return store
}

/** Drops every store, for tests. */
export function resetWorkspaceStores() {
  for (const store of stores.values()) store.dispose()
  stores.clear()
}
