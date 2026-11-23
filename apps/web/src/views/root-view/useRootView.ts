import type { BlockStatus, HubDescription, Item, ViewData } from '@16bit/core'
import { computed, getCurrentScope, onScopeDispose, shallowRef, watch } from 'vue'
import { asRequestError, type ApiRequestError } from '../../api/client.ts'
import type { WorkspaceStore } from '../../sync/store.ts'
import type { Load } from '../home/useDashboard.ts'
import { viewRequests, type RequestQueue } from './queue.ts'
import {
  browserTimeZone,
  dataBlocks,
  msUntilMidnight,
  readsToday,
  shownItemIds,
  staleBlocks,
  watches,
} from './refresh.ts'
import { readableBlocks, readTree } from './render-tree.ts'
import type { RawView, ViewSource } from './source.ts'

// A folder's root view on the hub page (D76, D83): the view, then every data block's data in one
// request with the tree's `version` and the reader's `tz`; the hub followed from that `seq`;
// blocks read again when what they show changes, at most once a second; the view read again on
// a `hub` event or when the data says the tree moved (409 `stale`).

/** One data block's data as the page holds it. */
export type BlockLoad =
  | { state: 'loading' }
  | { state: 'ready'; status: BlockStatus }
  /** The page's data request failed; the page says so once, the block shows its error. */
  | { state: 'failed' }

/**
 * What the folder shows: `default` is today's folder screen (no stored view, D76), `none` a
 * views-only folder with none ("No view yet"), `view` a stored root view.
 */
export type RootViewMode = 'loading' | 'error' | 'default' | 'none' | 'view'

/** What went wrong with the page's data, said once for the page. */
export type DataProblem = 'request' | 'blocks' | null

/** Changes gathered before blocks are read again, in ms (D83). */
export const REFRESH_DEBOUNCE = 300
/** At most one refetch per view per this many ms (D83). */
export const REFRESH_INTERVAL = 1_000

export interface RootViewOptions {
  source: ViewSource
  store: WorkspaceStore
  hubId: () => string
  /** The open folder; `null` until the hub is read. */
  folderId: () => string | null
  description: () => HubDescription | null
  queue?: RequestQueue
  timeZone?: string | undefined
  now?: () => number
}

export function useRootView(options: RootViewOptions) {
  const { source, store } = options
  const queue = options.queue ?? viewRequests
  const timeZone = 'timeZone' in options ? options.timeZone : browserTimeZone()
  const now = options.now ?? Date.now

  const view = shallowRef<{ folderId: string; load: Load<RawView> } | null>(null)
  const blocks = shallowRef<Readonly<Record<string, BlockLoad>>>({})
  const requestFailed = shallowRef(false)

  // Bumped by every view load: answers for an older one are dropped.
  let generation = 0
  let fetching = false
  let lastFetch = -Infinity
  const pending = new Set<string>()
  let pendingSince: number | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let midnightTimer: ReturnType<typeof setTimeout> | null = null

  const ready = computed(() => {
    const v = view.value
    return v?.load.state === 'ready' && v.folderId === options.folderId() ? v.load.data : null
  })
  const rendered = computed(() => (ready.value?.stored ? readTree(ready.value.tree) : null))
  const allBlocks = computed(() => readableBlocks(rendered.value?.page ?? null))
  const data = computed(() => dataBlocks(allBlocks.value))
  const watched = computed(() => watches(allBlocks.value, options.description()))

  const mode = computed<RootViewMode>(() => {
    const id = options.folderId()
    const v = view.value
    if (id === null || !v || v.folderId !== id || v.load.state === 'loading') return 'loading'
    if (v.load.state === 'error') return 'error'
    if (v.load.data.stored) return 'view'
    const d = options.description()
    const folder = d?.hub.id === id ? d.hub : d?.folders.find((f) => f.id === id)
    return folder?.viewsOnly ? 'none' : 'default'
  })
  const viewError = computed<ApiRequestError | null>(() =>
    view.value?.load.state === 'error' ? view.value.load.error : null,
  )

  const problem = computed<DataProblem>(() => {
    if (requestFailed.value) return 'request'
    return Object.values(blocks.value).some(
      (b) => b.state === 'ready' && b.status.status === 'error',
    )
      ? 'blocks'
      : null
  })

  function clearTimers() {
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    if (midnightTimer !== null) clearTimeout(midnightTimer)
    refreshTimer = null
    midnightTimer = null
    pending.clear()
    pendingSince = null
  }

  /** Reads the view. `keep` holds what is shown until the answer comes (a reload). */
  function loadView(folderId: string, keep: boolean) {
    const gen = ++generation
    clearTimers()
    fetching = false
    if (!keep || view.value?.folderId !== folderId) {
      view.value = { folderId, load: { state: 'loading' } }
      blocks.value = {}
      requestFailed.value = false
    }
    const done = (answer: RawView) => {
      if (gen !== generation) return
      view.value = { folderId, load: { state: 'ready', data: answer } }
      startData(gen)
    }
    const failed = (thrown: unknown) => {
      if (gen !== generation) return
      const error = asRequestError(thrown)
      // A reload that fails for a passing reason keeps the view shown and says so once.
      if (
        keep &&
        view.value?.load.state === 'ready' &&
        !error.isNotFound &&
        !error.isNoPermission
      ) {
        requestFailed.value = true
        return
      }
      view.value = { folderId, load: { state: 'error', error } }
    }
    let answer: RawView | Promise<RawView>
    try {
      answer = source.view(folderId)
    } catch (thrown) {
      failed(thrown)
      return
    }
    // The default source answers at once, so a folder with no view shows with no loading frame.
    if (answer instanceof Promise) answer.then(done, failed)
    else done(answer)
  }

  function startData(gen: number) {
    if (mode.value !== 'view') return
    const ids = data.value.map((b) => b.id)
    if (ids.length === 0) return
    const next: Record<string, BlockLoad> = {}
    for (const id of ids) next[id] = blocks.value[id] ?? { state: 'loading' }
    blocks.value = next
    void fetchData(gen, null)
    scheduleMidnight(gen)
  }

  /** Reads `ids`, or every data block for `null`. */
  async function fetchData(gen: number, ids: readonly string[] | null) {
    const v = ready.value
    if (!v || gen !== generation) return
    fetching = true
    lastFetch = now()
    const asked = ids ?? data.value.map((b) => b.id)
    let answer: ViewData
    try {
      answer = await queue.run(() =>
        source.data(v.folderId, {
          version: v.version,
          ...(ids ? { blocks: ids } : {}),
          ...(timeZone ? { tz: timeZone } : {}),
        }),
      )
    } catch (thrown) {
      if (gen !== generation) return
      fetching = false
      const error = asRequestError(thrown)
      // The tree moved past ours, or the folder went out of reach: read the view again.
      if (error.code === 'stale' || error.isNotFound || error.isNoPermission) {
        loadView(v.folderId, true)
        return
      }
      const next = { ...blocks.value }
      for (const id of asked) if (next[id]?.state !== 'ready') next[id] = { state: 'failed' }
      blocks.value = next
      requestFailed.value = true
      schedule()
      return
    }
    if (gen !== generation) return
    fetching = false
    const next = { ...blocks.value }
    for (const id of asked) {
      const status = answer.blocks[id]
      next[id] = status
        ? { state: 'ready', status }
        : { state: 'ready', status: { status: 'error', error: 'internal' } }
    }
    blocks.value = next
    requestFailed.value = false
    for (const item of answeredItems(answer)) store.apply(item)
    store.noteRead(options.hubId(), answer.seq)
    schedule()
  }

  /** Marks blocks stale; they are read again together, debounced and at most once a second. */
  function markStale(ids: readonly string[]) {
    if (ids.length === 0 || mode.value !== 'view') return
    for (const id of ids) pending.add(id)
    pendingSince ??= now()
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = null
    schedule()
  }

  function schedule() {
    if (pending.size === 0 || fetching || refreshTimer !== null) return
    const t = now()
    // Debounced, but a steady stream of changes still refreshes once a second at most.
    const debounced = Math.min(t + REFRESH_DEBOUNCE, (pendingSince ?? t) + REFRESH_INTERVAL)
    const at = Math.max(debounced, lastFetch + REFRESH_INTERVAL)
    const gen = generation
    refreshTimer = setTimeout(
      () => {
        refreshTimer = null
        const ids = [...pending].filter((id) => data.value.some((b) => b.id === id))
        pending.clear()
        pendingSince = null
        if (ids.length > 0) void fetchData(gen, ids.length === data.value.length ? null : ids)
      },
      Math.max(0, at - t),
    )
  }

  function scheduleMidnight(gen: number) {
    const today = data.value.filter(readsToday).map((b) => b.id)
    if (today.length === 0) return
    // A second past midnight, so the server's "today" has surely turned too.
    midnightTimer = setTimeout(
      () => {
        midnightTimer = null
        if (gen !== generation) return
        markStale(today)
        scheduleMidnight(gen)
      },
      msUntilMidnight(new Date(now()), timeZone) + 1_000,
    )
  }

  /** Reads every block again, as "Try again" does after a failure. */
  function retry() {
    const v = view.value
    if (!v) return
    if (v.load.state !== 'ready') {
      loadView(v.folderId, false)
      return
    }
    markStale(data.value.map((b) => b.id))
  }

  const release = store.hold(options.hubId())
  const stops = [
    store.on('change', (change) => {
      if (mode.value !== 'view') return
      markStale(
        staleBlocks(change, watched.value, (id) => {
          const b = blocks.value[id]
          return b?.state === 'ready' ? shownItemIds(b.status) : []
        }),
      )
    }),
    // A view write sends the hub NOTIFY (D76): a folder may have gained or lost its view.
    store.on('hub', (hubId) => {
      const id = options.folderId()
      if (hubId === options.hubId() && id !== null && mode.value !== 'loading') loadView(id, true)
    }),
    store.on('resync', (hubId) => {
      if (hubId === options.hubId()) markStale(data.value.map((b) => b.id))
    }),
  ]

  watch(
    options.folderId,
    (id) => {
      if (id !== null) {
        loadView(id, false)
        return
      }
      generation++
      clearTimers()
      view.value = null
      blocks.value = {}
    },
    { immediate: true },
  )

  function dispose() {
    generation++
    clearTimers()
    for (const stop of stops) stop()
    release()
  }
  if (getCurrentScope()) onScopeDispose(dispose)

  return {
    mode,
    view: ready,
    viewError,
    /** The page and its blocks as the renderer walks them. */
    rendered,
    blocks,
    problem,
    retry,
    reload: () => {
      const id = options.folderId()
      if (id !== null) loadView(id, false)
    },
    dispose,
  }
}

/** Items a view-data answer carries, for the store (D60): rows update in place from the feed. */
function answeredItems(answer: ViewData): Item[] {
  const out: Item[] = []
  for (const status of Object.values(answer.blocks)) {
    if (status.status !== 'ok') continue
    const d = status.data
    if (d.kind === 'items') out.push(...d.items)
    else if (d.kind === 'board') out.push(...d.columns.flatMap((c) => c.items))
    else if (d.kind === 'item' && d.item) out.push(d.item)
  }
  return out
}
