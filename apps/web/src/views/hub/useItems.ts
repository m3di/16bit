import {
  attributeTypes,
  conflictErrorSchema,
  itemQueryResultSchema,
  itemReadSchema,
  itemWriteResultSchema,
  type Attribute,
  type Filter,
  type Item,
  type ItemQueryResult,
  type ItemWriteResult,
  type Change,
  type ItemValues,
  type ValueError,
} from '@16bit/core'
import { getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue'
import {
  ApiRequestError,
  asRequestError,
  getJson,
  noContent,
  sendJson,
  type Fetch,
} from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'
import { yieldToMain } from '../../api/yield.ts'
import { backoff } from '../../sync/feed.ts'
import { workspaceStore, type WorkspaceStore } from '../../sync/store.ts'
import type { RowWindows } from '../../ui/data-table.ts'
import { FolderRows, WINDOW_SIZE } from './folder-rows.ts'
import { listValue, type LinkedState } from './relations.ts'

/** Direct reads of linked items running at once, until #73 lets one request cover them. */
export const LINKED_READ_LIMIT = 6

/** One sort key, as the table offers it. The query endpoint takes up to three. */
export interface SortKey {
  attribute: string
  direction: 'asc' | 'desc'
}

export interface ItemList {
  /** How many items the folder has (or pass the filter), as the last window read counted. */
  total: number
  /** The attribute order the rows are in, or `null` for item number, newest first (D61). */
  sort: SortKey | null
  /** The filter the rows pass, or `null` for the whole folder. */
  where: Filter | null
  /** A request for another order or filter is running; the rows shown are still the old ones. */
  sorting: boolean
  /** Offsets of windows whose read failed. Their rows stay placeholders until a retry. */
  failed: number[]
  /** Why the last window read failed. */
  failure: ApiRequestError | null
}

/** The rows in view were read again after a change (D61): where their items were before. */
export interface Reorder {
  before: ReadonlyMap<string, number>
}

/**
 * Where to scroll after the rows in view were read again (D61): the selected row's new index if
 * it was in view and moved, so the reader keeps it in view, or null to leave the scroll alone.
 */
export function followSelected(
  reorder: Reorder | null,
  selectedId: string | null,
  indexOf: (id: string) => number,
  isInView: (index: number) => boolean,
): number | null {
  const was = selectedId ? reorder?.before.get(selectedId) : undefined
  if (!selectedId || was === undefined || !isInView(was)) return null
  const index = indexOf(selectedId)
  return index >= 0 && index !== was ? index : null
}

/**
 * The query endpoint sorts only indexed attributes shown on the folder, of a type that can be
 * sorted (docs/ARCHITECTURE.md, "Query shape").
 */
export function canSort(attribute: Attribute): boolean {
  const type = attributeTypes[attribute.type]
  return attribute.indexed && type.sortable && type.indexProjection !== 'none'
}

/** A header click: ascending first, then descending, then back to the default order. */
export function nextSort(current: SortKey | null, attribute: string): SortKey | null {
  if (current?.attribute !== attribute) return { attribute, direction: 'asc' }
  return current.direction === 'asc' ? { attribute, direction: 'desc' } : null
}

/**
 * The query was refused because of its sort: a 400 whose `errors` name a `sort` path, for
 * example an attribute that is no longer indexed (docs/ARCHITECTURE.md, "Query shape").
 */
export function refusedSort(error: ApiRequestError): boolean {
  const raw = error.body?.['errors']
  if (error.status !== 400 || !Array.isArray(raw)) return false
  return (raw as { path?: unknown }[]).some(
    (e) => typeof e.path === 'string' && (e.path === 'sort' || e.path.startsWith('sort.')),
  )
}

export type CreateResult = { ok: true; item: Item } | { ok: false; error: ApiRequestError }

/** Ends a server message with a full stop, so another sentence can follow it. */
const sentence = (message: string) =>
  /[.!?]$/.test(message.trim()) ? message.trim() : `${message.trim()}.`

/** The `errors` of an `invalid_values` response, keyed by attribute ID. */
export function valueErrors(error: ApiRequestError): Record<string, string> {
  const raw = error.body?.['errors']
  if (error.code !== 'invalid_values' || !Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const e of raw as Partial<ValueError>[]) {
    if (typeof e.attributeId === 'string' && typeof e.message === 'string')
      out[e.attributeId] = e.message
  }
  return out
}

export type RemoveResult = { ok: true } | { ok: false; message: string }

/**
 * A random v4 UUID for a new item. `crypto.randomUUID` only exists in secure contexts
 * (HTTPS or localhost); over plain HTTP on any other host, `getRandomValues` still does.
 */
export function newItemId(c: Pick<Crypto, 'getRandomValues'> & Partial<Crypto> = crypto): string {
  if (typeof c.randomUUID === 'function') return c.randomUUID()
  const b = c.getRandomValues(new Uint8Array(16))
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * A response without the workspace `seq` it carries (D58, issue 168), so the store holds
 * items only. The `seq` itself goes to `noteRead`, which subscribes the hub with it.
 */
export function withoutSeq<T extends Item & { seq?: number | undefined }>(
  response: T,
): Omit<T, 'seq'> {
  const item = { ...response }
  delete item.seq
  return item
}

/** An item opened by ID inside a hub's page. One from another hub is reported as missing. */
export function inHub(result: Load<Item>, hubId: string): Load<Item> {
  if (result.state !== 'ready' || result.data.hubId === hubId) return result
  return {
    state: 'error',
    error: new ApiRequestError('not_found', 'This item is not in this hub.', 404),
  }
}

export interface ItemsOptions {
  /**
   * `false` for a page without a folder list (the item page): linked items are then read
   * without waiting for a list query that never comes.
   */
  list?: boolean
  /** The workspace's store; the tab's own by default (D60). */
  store?: WorkspaceStore
  /** The hub the list belongs to, so a list read keeps it live even when it is empty. */
  hubId?: () => string | null
  /**
   * How long a change that may reorder a sorted or filtered list waits before the rows in view
   * are read again, so a burst of changes costs one read (D61). In ms.
   */
  refetchDelay?: number
}

/** The default wait before the rows in view are read again after a reordering change. */
export const REFETCH_DELAY = 300

/** Attributes a filter tests, so a change to one of them can be seen to matter. */
export function filterAttributes(where: Filter | null): string[] {
  if (!where) return []
  if ('and' in where) return where.and.flatMap(filterAttributes)
  if ('or' in where) return where.or.flatMap(filterAttributes)
  return [where.attribute]
}

/**
 * Items of one hub as a view sees them: the selected folder's rows, single items opened by ID,
 * and writes. Items live in the workspace store (D60); this keeps which item is at which row
 * and what the view has read. The rows are read in windows of 200 by offset, with the folder's
 * `total`, by item number newest first unless an attribute sort is asked for (D61). Writes are optimistic: they sit in the store's pending layer with a
 * `clientMutationId` until the HTTP response confirms them, and are dropped on rejection (D59).
 * A 409 replaces the server copy with the item as it is now. Every read and write response
 * that carries a `seq` keeps its hub live from that `seq` (D58).
 */
export function useItems(
  workspaceId: string,
  idPrefix: () => string,
  fetchFn: Fetch = (...args) => fetch(...args),
  options: ItemsOptions = {},
) {
  const hasList = options.list ?? true
  const store = options.store ?? workspaceStore(workspaceId)
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId)}`
  const itemPath = (id: string) => `${base}/items/${encodeURIComponent(id)}`

  /**
   * Items this view has read since its hub was last reloaded. Only these are trusted from the
   * store without a request: another page may have left a copy that went stale while its hub
   * was not live.
   */
  const seen = new Set<string>()
  /** Hubs this view holds live, with their release. */
  const held = new Map<string, () => void>()
  /** Keeps a hub live from a read or write response at `seq`. */
  function noteRead(hubId: string | undefined | null, seq: number | undefined) {
    if (!hubId) return
    if (!held.has(hubId)) held.set(hubId, store.hold(hubId))
    store.noteRead(hubId, seq)
  }
  /** Takes in items read from the server and returns the copies the store holds. */
  function absorb(read: Item) {
    store.apply(read)
    seen.add(read.id)
    return store.get(read.id)
  }

  const list = ref<Load<ItemList>>({ state: 'loading' })
  const folderId = ref<string | null>(null)
  /** The last write that failed, shown until dismissed or replaced. */
  const notice = ref<string | null>(null)
  /**
   * Whether the notice explains the order the rows are in. The notice is shared with edit and
   * create failures, so a successful sort clears it only when a sort put it there.
   */
  let sortNotice = false
  const say = (text: string | null, fromSort = false) => {
    notice.value = text
    sortNotice = fromSort
  }
  /**
   * Linked items by ID, from `expand` on the folder query and from direct reads. Kept for the
   * life of the hub page on purpose: it is not cleared when another folder opens, so a chip
   * does not flicker back to loading. A reload of the page reads everything again.
   */
  const linked = ref<Record<string, LinkedState>>({})
  /** The server refused an edit with 403: the reader can see this hub's items but not change them. */
  const readOnly = ref(false)
  /** Relation attributes the open folder's query expands. */
  let expand: string[] = []
  /** The order asked for. While a new order loads, the rows are still in `list.data.sort`. */
  const sort = ref<SortKey | null>(null)
  /** The filter asked for. While it loads, the rows still pass `list.data.where`. */
  const where = ref<Filter | null>(null)

  let generation = 0
  const queues = new Map<string, Promise<unknown>>()
  const opening = new Map<string, Promise<Load<Item>>>()
  /** Items opened by ID (the panel, the item page), read again on a resync. */
  const opened = new Set<string>()

  const label = (item: Item | undefined) =>
    item && !store.isCreating(item.id) ? `${idPrefix()}-${String(item.seqId)}` : 'the new item'

  /** An item as shown: the server copy with pending writes applied in order. */
  const view = (id: string): Item | undefined => store.view(id)

  /**
   * Which item is at which row. Not reactive itself, since it can hold 50,000 positions;
   * `rowsChanged` tells the table to read it again.
   */
  let positions = new FolderRows()
  const rowsVersion = ref(0)
  /** Windows being read for the current rows, by offset. */
  const loading = new Set<number>()
  /** The rows the table shows and the windows that hold them, from its last `windows` event. */
  let inView: RowWindows | null = null
  /** The last reorder of the rows in view, so the screen can keep the selected row in view. */
  const reordered = shallowRef<Reorder | null>(null)
  /**
   * For a sorted or filtered list, what each listed item had in the attributes that order or
   * filter it, when it was read. A change to them may move the row (D61).
   */
  const orderKeys = new Map<string, string>()
  /** Items this view deleted, so the echo of a delete does not read the rows again. */
  const removedHere = new Set<string>()
  /**
   * The highest item number this view has seen in the open folder. Items never change folder,
   * so an item it has not listed with a higher number is new, and first in the default order,
   * whatever its version: a create and an edit made together reach the feed as one change (D58).
   */
  let highestSeen = 0
  const see = (seqId: number) => {
    if (seqId > highestSeen) highestSeen = seqId
  }

  function rowsChanged() {
    rowsVersion.value++
    if (list.value.state === 'ready') list.value.data.total = positions.total
  }

  /**
   * Rows were added or removed: later rows moved by one, and holes moved into loaded windows.
   * The windows in view that are no longer whole are read again; the table only asks when the
   * windows in view change.
   */
  function rowsShifted() {
    rowsChanged()
    if (inView) showWindows(inView)
  }

  /** The item at a row, or undefined while its window is not loaded. */
  function rowAt(index: number): Item | undefined {
    if (rowsVersion.value < 0) return undefined // Read only to track changes to the rows.
    const id = positions.ids[index]
    return id === undefined ? undefined : view(id)
  }

  /** The row an item is at, or -1 when it is not loaded. */
  function indexOf(id: string): number {
    if (rowsVersion.value < 0) return -1 // Read only to track changes to the rows.
    return positions.indexOf(id)
  }

  const isCreating = (id: string) => store.isCreating(id)
  const isSaving = (id: string) => store.isSaving(id)

  /**
   * Keeps what an expanded page says about its linked items. An ID in an expanded value with
   * no entry was deleted, unless the server cut `linked` short.
   */
  function absorbLinked(page: Omit<ItemQueryResult, 'seq'>, attributes: readonly string[]) {
    for (const [id, entry] of Object.entries(page.linked ?? {})) linked.value[id] = entry
    if (page.linkedTruncated || attributes.length === 0) return
    for (const item of page.items) {
      for (const attributeId of attributes) {
        for (const id of listValue(item.values[attributeId])) {
          if (!page.linked?.[id]) linked.value[id] = { access: 'gone' }
        }
      }
    }
  }

  /** Whether rows are in an attribute order or filtered, so a change may move them (D61). */
  const reorders = (data: Pick<ItemList, 'sort' | 'where'>) =>
    data.sort !== null || data.where !== null

  /** What an item has in the attributes that order or filter the list. */
  function orderKey(item: Item, data: Pick<ItemList, 'sort' | 'where'>): string {
    const attributes = [
      ...(data.sort ? [data.sort.attribute] : []),
      ...filterAttributes(data.where),
    ]
    return JSON.stringify(attributes.map((a) => item.values[a] ?? null))
  }

  /** Items checked per task when a window arrives, so no one task checks all 200 (issue 218). */
  const ITEMS_PER_SLICE = 50
  const itemsSchema = itemQueryResultSchema.shape.items
  /** A window response with its items not checked yet: they are checked in slices below. */
  const windowEnvelope = {
    parse(data: unknown): Omit<ItemQueryResult, 'items'> & { items: unknown[] } {
      const raw = data as { items?: unknown } | null
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) throw new Error('No items')
      const envelope = itemQueryResultSchema.parse({ ...raw, items: [] })
      return { ...envelope, items: raw.items as unknown[] }
    },
  }
  /**
   * A window read whose caller has moved on (another folder, order, or read). It stops at the
   * next slice instead of checking and taking in rows nobody will show; the caller's own
   * generation check then drops it, as it drops any stale read.
   */
  class StaleRead extends Error {}
  /** Checks a window's items against the contract, one slice per task. */
  async function checkItems(items: unknown[], stale: () => boolean): Promise<Item[]> {
    const checked: Item[] = []
    for (let i = 0; i < items.length; i += ITEMS_PER_SLICE) {
      if (i > 0) {
        await yieldToMain()
        if (stale()) throw new StaleRead()
      }
      const slice = itemsSchema.safeParse(items.slice(i, i + ITEMS_PER_SLICE))
      if (!slice.success)
        throw new ApiRequestError('bad_response', 'The server sent an unexpected response.', 200)
      checked.push(...slice.data)
    }
    return checked
  }

  /**
   * Reads one window of the open folder (D61), with the folder's total. The response is checked
   * and taken in over several tasks, so a 200-row window never holds the main thread for long.
   */
  async function fetchWindow(
    folder: string,
    offset: number,
    order: SortKey | null,
    filter: Filter | null,
    stale: () => boolean,
  ) {
    const attributes = expand
    const envelope = await sendJson(
      'POST',
      `${base}/query`,
      {
        from: folder,
        limit: WINDOW_SIZE,
        offset,
        count: true,
        expand: attributes,
        sort: order ? [order] : [],
        // Without an attribute sort, item number newest first: an edit never moves a row.
        ...(order ? {} : { order: 'number' }),
        ...(filter ? { where: filter } : {}),
      },
      windowEnvelope,
      fetchFn,
    )
    const page: ItemQueryResult = { ...envelope, items: await checkItems(envelope.items, stale) }
    // The rows are taken into the store in a task of their own.
    await yieldToMain()
    if (stale()) throw new StaleRead()
    for (const item of page.items) absorb(item)
    noteRead(options.hubId?.() ?? page.items[0]?.hubId, page.seq)
    absorbLinked(page, attributes)
    // The caller puts the rows in place and the table renders them, in another task.
    await yieldToMain()
    return page
  }

  /** Puts a window read into `into`, keeping each row's order key when the list needs them. */
  function putWindow(
    into: FolderRows,
    offset: number,
    page: ItemQueryResult,
    data: Pick<ItemList, 'sort' | 'where'>,
  ) {
    into.put(
      offset,
      page.items.map((i) => i.id),
      page.total ?? into.total,
    )
    for (const item of page.items) see(item.seqId)
    if (reorders(data)) for (const item of page.items) orderKeys.set(item.id, orderKey(item, data))
  }

  /** What is known about a linked item. */
  const linkState = (id: string): LinkedState => linked.value[id] ?? { access: 'unknown' }

  /** Records an item the reader just picked to link to: they can read it. */
  function rememberLinked(item: Item) {
    linked.value[item.id] = { access: 'read', item }
  }

  /** Linked IDs waiting for a direct read, and how many reads are running. */
  const linkWaiting: string[] = []
  let linkReads = 0

  /** Starts waiting direct reads, at most `LINKED_READ_LIMIT` at a time. */
  function pumpLinked() {
    while (linkReads < LINKED_READ_LIMIT && linkWaiting.length > 0) {
      const id = linkWaiting.shift() as string
      if (linkState(id).access !== 'unknown') continue
      // What the expanded folder query says wins over a direct read: only it can tell "no
      // access" from "deleted". So a read that ends after the list answered is dropped.
      const settle = (state: LinkedState) => {
        if (linkState(id).access === 'unknown') linked.value[id] = state
      }
      linkReads++
      const run = getJson(itemPath(id), itemReadSchema, fetchFn)
        .then((read): Load<Item> => {
          const item = withoutSeq(read)
          settle({ access: 'read', item })
          return { state: 'ready', data: item }
        })
        .catch((thrown: unknown): Load<Item> => {
          const error = asRequestError(thrown)
          settle(error.isNotFound ? { access: 'none' } : { access: 'error' })
          return { state: 'error', error }
        })
        .finally(() => {
          opening.delete(`link:${id}`)
          linkReads--
          pumpLinked()
        })
      opening.set(`link:${id}`, run)
    }
  }

  /**
   * Reads linked items the folder query did not cover, one by one, a few at a time. A 404 is
   * shown as "no access": the server answers the same for hidden and deleted items, and "no
   * access" never shows anything of the item (#73 asks for a read with `expand` instead).
   */
  function resolveLinked(ids: Iterable<string>) {
    // Nothing is read while the list is loading: its answer may cover these IDs.
    if (hasList && list.value.state === 'loading') return
    for (const id of ids) {
      if (linkState(id).access !== 'unknown' || opening.has(`link:${id}`)) continue
      if (linkWaiting.includes(id)) continue
      linkWaiting.push(id)
    }
    pumpLinked()
  }

  type Order = Pick<ItemList, 'sort' | 'where'>

  /** A fresh list from windows read in one order, replacing the rows. */
  function freshRows(order: Order, reads: { offset: number; page: ItemQueryResult }[]) {
    const next = new FolderRows()
    orderKeys.clear()
    for (const { offset, page } of reads) putWindow(next, offset, page, order)
    positions = next
    loading.clear()
  }

  const readyList = (order: Order, total: number): Load<ItemList> => ({
    state: 'ready',
    data: { total, ...order, sorting: false, failed: [], failure: null },
  })

  /** Reads windows at `offsets` together; the rows are only replaced once all have arrived. */
  async function readWindows(
    folder: string,
    offsets: readonly number[],
    order: Order,
    stale: () => boolean,
  ) {
    const pages = await Promise.all(
      offsets.map((offset) => fetchWindow(folder, offset, order.sort, order.where, stale)),
    )
    return offsets.map((offset, i) => ({ offset, page: pages[i] as ItemQueryResult }))
  }

  /** The windows the table shows, or the first one before it has said. */
  const offsetsInView = () => (inView && inView.offsets.length > 0 ? inView.offsets : [0])

  const staleSortNotice =
    'The table can no longer be sorted by that column, so the items are shown newest first.'

  /**
   * Reads the open folder's first window in the order asked for, from the loading state. If
   * the server refuses the sort, the sort is dropped and the default order is read instead, so a
   * retry never sends the refused sort again. `dropped` says a refused sort was just dropped:
   * the notice says so once the default order is shown, and not before.
   */
  async function reload(dropped = false) {
    const gen = ++generation
    const folder = folderId.value
    if (!folder) return
    const order: Order = { sort: sort.value, where: where.value }
    list.value = { state: 'loading' }
    // The table is mounted afresh at the top once the rows arrive.
    inView = null
    try {
      const reads = await readWindows(folder, [0], order, () => gen !== generation)
      if (gen !== generation) return
      freshRows(order, reads)
      list.value = readyList(order, positions.total)
      rowsChanged()
      if (dropped) say(staleSortNotice, true)
    } catch (thrown) {
      if (gen !== generation) return
      const error = asRequestError(thrown)
      if (order.sort && refusedSort(error)) {
        sort.value = null
        await reload(true)
        return
      }
      list.value = { state: 'error', error }
    }
  }

  /**
   * Shows a folder's rows. `expandIds` are relation attributes whose linked items come back
   * with each window. Another folder starts in the default order, item number newest first, and
   * unfiltered; the same folder keeps its order while the attribute is among `sortableIds`, the
   * folder's columns that pass `canSort`.
   */
  async function openFolder(
    id: string,
    expandIds: readonly string[] = [],
    sortableIds?: readonly string[],
  ) {
    let dropped = false
    if (id !== folderId.value) {
      sort.value = null
      where.value = null
      // Item numbers only grow, so the mark stays valid while the same folder is open.
      highestSeen = 0
    } else if (sort.value && sortableIds && !sortableIds.includes(sort.value.attribute)) {
      sort.value = null
      dropped = true
    }
    folderId.value = id
    expand = [...expandIds]
    await reload(dropped)
  }

  /**
   * Shows the folder in another order or with another filter. The header shows the new order
   * at once and the rows stay until the windows in view arrive in it; the windows elsewhere are
   * dropped and read again when scrolled to (D61). If the server refuses, the rows' order comes
   * back and the notice says why.
   */
  async function requery(next: Order) {
    sort.value = next.sort
    where.value = next.where
    const current = list.value
    const folder = folderId.value
    if (current.state !== 'ready' || !folder) {
      await reload()
      return
    }
    const gen = ++generation
    const data = current.data
    data.sorting = true
    const rows = positions
    const shifts = rows.shifts
    try {
      const reads = await readWindows(folder, offsetsInView(), next, () => gen !== generation)
      if (gen !== generation) return
      freshRows(next, reads)
      list.value = readyList(next, positions.total)
      rowsChanged()
      if (inView) showWindows(inView)
      // A create or delete while this was read may be missing from it: read the view again.
      if (rows.shifts !== shifts) scheduleRefetch()
      // The rows are in the order asked for, so a notice about the previous order no longer applies.
      if (sortNotice) say(null)
    } catch (thrown) {
      if (gen !== generation) return
      const error = asRequestError(thrown)
      data.sorting = false
      sort.value = data.sort
      where.value = data.where
      const reason = refusedSort(error)
        ? 'This column can no longer be sorted; reload the page to see the current columns.'
        : `The items could not be shown in that order. ${sentence(error.message)}`
      say(`${reason} The items are shown in the previous order.`, true)
    }
  }

  const setSort = (next: SortKey | null) => requery({ sort: next, where: where.value })
  /** Filters the rows. The folder view has no filter controls yet; the rows follow D61 already. */
  const setFilter = (next: Filter | null) => requery({ sort: sort.value, where: next })

  /** Reads one window the table needs, in the order the rows are in. */
  async function loadWindow(offset: number) {
    const current = list.value
    const folder = folderId.value
    if (current.state !== 'ready' || !folder) return
    const data = current.data
    const gen = generation
    const rows = positions
    const shifts = rows.shifts
    loading.add(offset)
    data.failed = data.failed.filter((o) => o !== offset)
    try {
      const page = await fetchWindow(
        folder,
        offset,
        data.sort,
        data.where,
        () => gen !== generation,
      )
      if (gen !== generation) return
      if (rows.shifts !== shifts) {
        // Rows were added or removed while this was read, so it belongs at other rows: drop it,
        // and read the windows in view again.
        loading.delete(offset)
        if (inView) showWindows(inView)
        return
      }
      putWindow(positions, offset, page, data)
      rowsChanged()
    } catch (thrown) {
      if (gen !== generation) return
      const error = asRequestError(thrown)
      if (data.sort && refusedSort(error)) {
        // The column can no longer be sorted: show the default order, and say why.
        sort.value = null
        await reload(true)
        return
      }
      data.failed = [...data.failed, offset]
      data.failure = error
    } finally {
      if (gen === generation) loading.delete(offset)
    }
  }

  /**
   * The table's `windows` event: the rows in view and the windows that hold them. Reads the
   * windows not loaded yet. A window whose read failed waits for `retryWindows`.
   */
  function showWindows(windows: RowWindows) {
    inView = windows
    const current = list.value
    if (current.state !== 'ready' || current.data.sorting) return
    for (const offset of windows.offsets) {
      if (loading.has(offset) || current.data.failed.includes(offset)) continue
      if (!positions.hasWindow(offset)) void loadWindow(offset)
    }
  }

  /** Reads the windows that failed again. */
  function retryWindows() {
    const current = list.value
    if (current.state !== 'ready') return
    const offsets = current.data.failed
    current.data.failed = []
    current.data.failure = null
    for (const offset of offsets) void loadWindow(offset)
  }

  let refetchTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Reads the windows in view again after a change that may have moved rows (D61), debounced.
   * The rows stay until the windows arrive; the ones out of view are dropped and read again
   * when scrolled to.
   */
  function scheduleRefetch() {
    if (refetchTimer !== null) clearTimeout(refetchTimer)
    refetchTimer = setTimeout(() => {
      refetchTimer = null
      void refetchInView()
    }, options.refetchDelay ?? REFETCH_DELAY)
  }

  /**
   * Reads the windows in view again and replaces the rows. Resolves `false` when the read failed
   * and the rows may have missed changes; a folder now out of reach (404, 403) shows that state
   * instead and counts as read.
   */
  async function refetchInView(): Promise<boolean> {
    const current = list.value
    const folder = folderId.value
    // Nothing shown yet, or a new order on its way that replaces the rows anyway.
    if (current.state !== 'ready' || current.data.sorting || !folder) return true
    const data = current.data
    const order: Order = { sort: data.sort, where: data.where }
    const gen = ++generation
    loading.clear()
    const offsets = offsetsInView()
    for (const offset of offsets) loading.add(offset)
    const rows = positions
    const shifts = rows.shifts
    const before = new Map<string, number>()
    if (inView) {
      for (let i = inView.start; i < inView.end; i++) {
        const id = positions.ids[i]
        if (id) before.set(id, i)
      }
    }
    try {
      const reads = await readWindows(folder, offsets, order, () => gen !== generation)
      // A later read replaces this one and answers for it.
      if (gen !== generation) return true
      freshRows(order, reads)
      data.failed = []
      data.failure = null
      rowsChanged()
      reordered.value = { before }
      // A window scrolled to while these were read was dropped with the old rows.
      if (inView) showWindows(inView)
      // A create or delete while this was read may be missing from it: read the view again.
      if (rows.shifts !== shifts) scheduleRefetch()
      return true
    } catch (thrown) {
      if (gen !== generation) return true
      loading.clear()
      const error = asRequestError(thrown)
      if (error.isNotFound || error.isNoPermission) {
        list.value = { state: 'error', error }
        return true
      }
      // The rows shown stay; the next change, a scroll or a resync retry reads them again.
      return false
    }
  }

  const gone = (): Load<Item> => ({
    state: 'error',
    error: new ApiRequestError('not_found', 'This item has been deleted.', 404),
  })

  /** Reads an item, keeps it in the store, and keeps its hub live from the read's `seq`. */
  async function fetchItem(path: string) {
    const {
      seq,
      linked: links,
      linkedTruncated,
      ...read
    } = await getJson(path, itemReadSchema, fetchFn)
    const item = absorb(read)
    noteRead(read.hubId, seq)
    return { links, linkedTruncated, item }
  }

  /**
   * Makes sure an item is in the store. A copy this view has read is used as it is; any other
   * is read again, since it may have gone stale while its hub was not live.
   */
  function openItem(id: string): Promise<Load<Item>> {
    if (store.isDeleted(id)) return Promise.resolve(gone())
    opened.add(id)
    const known = store.get(id)
    if (known && (seen.has(id) || store.isLive(known.hubId)))
      return Promise.resolve({ state: 'ready', data: known })
    let running = opening.get(id)
    if (!running) {
      running = fetchItem(itemPath(id))
        .then(({ item }): Load<Item> => (item ? { state: 'ready', data: item } : gone()))
        .catch((error: unknown): Load<Item> => ({ state: 'error', error: asRequestError(error) }))
        .finally(() => opening.delete(id))
      opening.set(id, running)
    }
    return running
  }

  /**
   * Reads an item again with `expand` (relation attributes, at most `MAX_EXPAND_ATTRIBUTES`),
   * so its linked items arrive with it, as with a folder query. The store keeps whichever
   * version is newer.
   */
  async function readItem(id: string, expandIds: readonly string[]): Promise<Load<Item>> {
    const query =
      expandIds.length > 0 ? `?expand=${expandIds.map(encodeURIComponent).join(',')}` : ''
    try {
      opened.add(id)
      const { links, linkedTruncated, item } = await fetchItem(`${itemPath(id)}${query}`)
      if (!item) return gone()
      absorbLinked({ items: [item], nextCursor: null, linked: links, linkedTruncated }, expandIds)
      return { state: 'ready', data: item }
    } catch (thrown) {
      return { state: 'error', error: asRequestError(thrown) }
    }
  }

  /** Runs writes to one item one after another, so each sends the version the last one got. */
  function enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(id) ?? Promise.resolve()).then(task, task)
    const tail = run.catch(() => undefined)
    queues.set(id, tail)
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id)
    })
    return run
  }

  /** Edits a 409 refused, by item, until the reader keeps them or takes the other value. */
  const refusedEdits = ref<Record<string, { values: ItemValues; by: string }>>({})
  /** The reader's refused value for one field, and the principal whose change won. */
  function refusedValue(id: string, attributeId: string) {
    const entry = refusedEdits.value[id]
    if (!entry || !(attributeId in entry.values)) return null
    return { value: entry.values[attributeId] ?? null, by: entry.by }
  }
  /** A save of this field is pending: sent or queued, not yet confirmed or refused. */
  function savingField(id: string, attributeId: string) {
    return store.pending(id).some((w) => w.kind === 'patch' && attributeId in w.values)
  }
  function forgetRefused(id: string, attributeIds: readonly string[]) {
    const entry = refusedEdits.value[id]
    if (!entry) return
    const values = Object.fromEntries(
      Object.entries(entry.values).filter(([k]) => !attributeIds.includes(k)),
    )
    if (Object.keys(values).length === 0) Reflect.deleteProperty(refusedEdits.value, id)
    else refusedEdits.value[id] = { ...entry, values }
  }

  /**
   * The versions this view's own confirmed writes moved each item through, `from` to `to`. A
   * queued write sends the version the reader's edit was based on, moved on only by these: a
   * change by someone else that the feed delivered meanwhile still makes it a 409, never a
   * silent overwrite (D8, D58).
   */
  const ownSteps = new Map<string, Map<number, number>>()
  function versionFor(id: string, base: number): number {
    const steps = ownSteps.get(id)
    let version = base
    for (let next = steps?.get(version); next !== undefined; next = steps?.get(version))
      version = next
    return version
  }
  function stepped(id: string, from: number, to: number) {
    const steps = ownSteps.get(id) ?? new Map<number, number>()
    steps.set(from, to)
    ownSteps.set(id, steps)
  }

  /** Takes in a write's response: the item as written, and the `seq` it was written at. */
  function confirmed(response: ItemWriteResult) {
    const { seq } = response
    const item = absorb(withoutSeq(response))
    noteRead(response.hubId, seq)
    return item
  }

  /**
   * Applies `values` at once and saves them. Resolves `true` when the server accepted them.
   * On a 409 the item shows the server's current values, and every edit still queued for it
   * is dropped, since it was made against the old version. Any other failure undoes this edit.
   */
  function save(id: string, values: ItemValues, basedOn: number | null = null): Promise<boolean> {
    // The server does not have the item yet, so there is nothing to PATCH.
    if (store.isCreating(id)) {
      say('The new item is still being saved. Edit it once it has been created.')
      return Promise.resolve(false)
    }
    const mutationId = newItemId()
    // The version the reader's edit is based on: from the field when it knows (a draft kept while
    // someone else saved, D60), else the server copy they see under their own edits.
    const base = basedOn ?? store.get(id)?.version
    store.addPending(id, { kind: 'patch', mutationId, values })
    const drop = () => {
      store.dropPending(id, mutationId)
    }

    return enqueue(id, async () => {
      if (!store.pending(id).some((w) => w.mutationId === mutationId)) return false
      const before = store.get(id)
      if (!before || base === undefined) {
        drop()
        return false
      }
      const version = versionFor(id, base)
      try {
        const response = await sendJson(
          'PATCH',
          itemPath(id),
          { version, values, clientMutationId: mutationId },
          itemWriteResultSchema,
          fetchFn,
        )
        stepped(id, version, response.version)
        const saved = confirmed(response)
        drop()
        forgetRefused(id, Object.keys(values))
        // Without the feed nothing else says that the row may have moved.
        if (saved) checkOrder(saved)
        return true
      } catch (thrown) {
        const error = asRequestError(thrown)
        const conflict = conflictErrorSchema.safeParse(error.body)
        if (error.status === 403) {
          drop()
          readOnly.value = true
          say(
            `Your change to ${label(before)} was not saved. You can view the items in this hub but not change them.`,
          )
        } else if (error.code === 'conflict' && conflict.success) {
          // Every edit still pending was made against the old version: all of them are offered
          // back field by field ("Keep mine"), beside the other person's values.
          const mine = store
            .pending(id)
            .reduce<ItemValues>(
              (acc, w) => (w.kind === 'patch' ? { ...acc, ...w.values } : acc),
              {},
            )
          refusedEdits.value[id] = {
            values: { ...refusedEdits.value[id]?.values, ...mine },
            by: conflict.data.current.updatedBy,
          }
          store.apply(conflict.data.current)
          store.dropPendingKind(id, 'patch')
          say(
            `${label(before)} was changed by someone else before your edit was saved. Your edit was not applied; the latest values are shown.`,
          )
        } else {
          drop()
          say(`Your change to ${label(before)} was not saved. ${error.message}`)
        }
        return false
      }
    })
  }

  /**
   * Adds the item to the top of the rows at once and creates it: the default order is item
   * number, newest first, so a new item is first. The client picks the ID, so the row keeps its
   * identity when the server confirms it. On failure the row is removed. In an attribute order
   * or with a filter the rows in view are read again once it is created (D61).
   */
  async function create(values: ItemValues): Promise<CreateResult> {
    const folder = folderId.value
    if (!folder) {
      return { ok: false, error: new ApiRequestError('invalid_request', 'No folder is open.') }
    }
    const id = newItemId()
    const mutationId = newItemId()
    const placeholder: Item = {
      workspaceId,
      id,
      hubId: options.hubId?.() ?? '',
      folderId: folder,
      seqId: 1,
      values,
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: '',
    }
    store.addPending(id, { kind: 'create', mutationId, item: Object.freeze(placeholder) })
    const gen = generation
    if (list.value.state === 'ready') {
      positions.insertAt(0, id)
      rowsShifted()
    }

    try {
      const response = await sendJson(
        'POST',
        `${base}/items`,
        { id, folderId: folder, values, clientMutationId: mutationId },
        itemWriteResultSchema,
        fetchFn,
      )
      const item = confirmed(response) ?? withoutSeq(response)
      if (item.folderId === folderId.value) see(item.seqId)
      if (list.value.state === 'ready' && reorders(list.value.data)) scheduleRefetch()
      return { ok: true, item }
    } catch (thrown) {
      const error = asRequestError(thrown)
      if (gen === generation && list.value.state === 'ready') {
        positions.removeAt(positions.indexOf(id))
        rowsShifted()
      }
      if (error.status === 403) {
        readOnly.value = true
        say('The item was not created. You can view the items in this hub but not add them.')
      } else {
        say(`The item was not created. ${error.message}`)
      }
      return { ok: false, error }
    } finally {
      store.dropPending(id, mutationId)
    }
  }

  /** Takes a row out; later rows move up. Returns where it was, or -1. */
  function unlist(id: string): number {
    const at = positions.indexOf(id)
    if (at >= 0) {
      positions.removeAt(at)
      orderKeys.delete(id)
      rowsShifted()
    }
    return at
  }

  /**
   * Deletes an item at the version shown, after any edit still on its way. The row leaves at
   * once and comes back at its place if the server refuses, with the reason. On a 409 the item
   * shows its current values and the message says so; a 404 means it is already gone, which is
   * what was asked.
   */
  function remove(id: string): Promise<RemoveResult> {
    if (store.isCreating(id)) {
      return Promise.resolve({
        ok: false,
        message: 'The new item is still being saved. Delete it once it has been created.',
      })
    }
    const shown = store.get(id)
    if (!shown) return Promise.resolve({ ok: false, message: 'This item is not loaded.' })
    const mutationId = newItemId()
    store.addPending(id, { kind: 'delete', mutationId })
    const gen = generation
    removedHere.add(id)
    const at = unlist(id)
    const putBack = () => {
      removedHere.delete(id)
      if (at < 0 || gen !== generation || list.value.state !== 'ready') return
      if (positions.indexOf(id) < 0) positions.insertAt(at, id)
      rowsShifted()
    }
    return enqueue(id, async (): Promise<RemoveResult> => {
      const before = store.get(id) ?? shown
      // The version shown when the reader asked, moved on only by their own edits before it.
      const version = versionFor(id, shown.version)
      try {
        const query = `?version=${String(version)}&clientMutationId=${mutationId}`
        await sendJson('DELETE', `${itemPath(id)}${query}`, undefined, noContent, fetchFn)
      } catch (thrown) {
        const error = asRequestError(thrown)
        const conflict = conflictErrorSchema.safeParse(error.body)
        if (!error.isNotFound) {
          store.dropPending(id, mutationId)
          putBack()
        }
        if (error.isNotFound) {
          // Fall through: it is gone either way.
        } else if (error.status === 403) {
          readOnly.value = true
          return {
            ok: false,
            message: `${label(before)} was not deleted. You can view the items in this hub but not change them.`,
          }
        } else if (error.code === 'conflict' && conflict.success) {
          store.apply(conflict.data.current)
          store.dropPendingKind(id, 'patch')
          return {
            ok: false,
            message: `${label(before)} was changed by someone else, so it was not deleted. The latest values are shown; delete it again if you still want to.`,
          }
        } else {
          return {
            ok: false,
            message: `${label(before)} was not deleted. ${sentence(error.message)}`,
          }
        }
      }
      store.tombstone(id)
      store.dropPending(id, mutationId)
      unlist(id)
      return { ok: true }
    })
  }

  /**
   * A listed item changed: in an attribute order or with a filter, a change to the attributes
   * that order or filter the rows may move it, so the rows in view are read again (D61). In the
   * default order an edit never moves a row.
   */
  function checkOrder(item: Item) {
    const current = list.value
    if (current.state !== 'ready' || !reorders(current.data)) return
    if (positions.indexOf(item.id) < 0) return
    const key = orderKey(item, current.data)
    if (orderKeys.get(item.id) === key) return
    orderKeys.set(item.id, key)
    scheduleRefetch()
  }

  /**
   * Keeps the rows in step with the feed (D61). A listed item updates in place, and leaves when
   * it is deleted or moved to another folder; later rows move up. In the default order (item
   * number, newest first) a new item goes first. A change that may reorder a sorted or filtered
   * list, or that the rows loaded cannot place, reads the rows in view again, debounced. The
   * echo of the reader's own create is already listed, so it is not added twice (D59).
   */
  function onChange(change: Change) {
    const current = list.value
    if (current.state !== 'ready') return
    const data = current.data
    const listed = positions.indexOf(change.itemId) >= 0
    const item = store.get(change.itemId)
    if (!change.item || !item) {
      // Gone. One that is not loaded may still have been in this folder, and counted, unless
      // it was in another hub or this view deleted it (the echo of its own delete).
      const own = removedHere.delete(change.itemId)
      const hub = options.hubId?.()
      const elsewhere = hub !== undefined && hub !== null && change.hubId !== hub
      if (unlist(change.itemId) < 0 && !own && !elsewhere) scheduleRefetch()
      return
    }
    if (item.folderId !== folderId.value) {
      unlist(item.id)
      return
    }
    seen.add(item.id)
    if (listed) {
      checkOrder(item)
      return
    }
    // Numbered above every item this view has seen: new, whatever its version.
    const isNew = item.seqId > highestSeen
    see(item.seqId)
    if (reorders(data)) {
      scheduleRefetch()
      return
    }
    // A new item has the highest number, so it is first. Any other unlisted item among the rows
    // in view has a place only a read can say.
    if (isNew) {
      positions.insertAt(0, item.id)
      rowsShifted()
    } else if (withinView(item.seqId)) scheduleRefetch()
  }

  /** In the default order: whether an item number falls among the rows in view. */
  function withinView(seqId: number): boolean {
    if (!inView) return true
    const first = positions.ids[inView.start]
    const last = positions.ids[inView.end - 1]
    const top = first === undefined ? undefined : store.get(first)?.seqId
    const bottom = last === undefined ? undefined : store.get(last)?.seqId
    if (top === undefined || bottom === undefined) return true
    return seqId <= top && seqId >= bottom
  }

  /**
   * Too much was missed while away (D58): read the windows in view and the items opened by ID
   * again, so their reads subscribe the hub afresh from their `seq`. The rows stay until the
   * windows arrive. Until a read succeeds the hub is not live: the shell says so, and the reads
   * are tried again with the feed's backoff. A folder now out of reach shows that instead.
   */
  let resyncTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  /** A function, so the check after an `await` is not narrowed away by the one before it. */
  const isDisposed = () => disposed
  async function onResync(hubId: string, attempt = 0) {
    if (isDisposed() || !held.has(hubId)) return
    if (resyncTimer !== null) clearTimeout(resyncTimer)
    resyncTimer = null
    seen.clear()
    const reads: Promise<boolean>[] = [...opened].map((id) =>
      fetchItem(itemPath(id)).then(
        () => true,
        () => false,
      ),
    )
    if (hasList) reads.push(refetchInView())
    if (reads.length === 0) return
    const results = await Promise.all(reads)
    // Every read must land: a copy that failed to reload missed changes no feed will resend.
    if (isDisposed() || results.every(Boolean)) return
    store.markBehind(hubId)
    resyncTimer = setTimeout(() => void onResync(hubId, attempt + 1), backoff(attempt))
  }

  const stops = [store.on('change', onChange), store.on('resync', (hubId) => void onResync(hubId))]
  /** Lets go of the store: listeners and live hubs. Runs on its own when the scope ends. */
  function dispose() {
    disposed = true
    if (resyncTimer !== null) clearTimeout(resyncTimer)
    if (refetchTimer !== null) clearTimeout(refetchTimer)
    for (const stop of stops) stop()
    for (const release of held.values()) release()
    held.clear()
  }
  if (getCurrentScope()) onScopeDispose(dispose)

  const dismissNotice = () => {
    say(null)
  }

  return {
    list,
    rowAt,
    indexOf,
    reordered,
    folderId,
    sort,
    setSort,
    where,
    setFilter,
    showWindows,
    retryWindows,
    notice,
    view,
    isSaving,
    isCreating,
    label,
    openFolder,
    openItem,
    readItem,
    save,
    create,
    remove,
    dismissNotice,
    linked,
    linkState,
    rememberLinked,
    resolveLinked,
    readOnly,
    store,
    dispose,
    refusedValue,
    forgetRefused,
    savingField,
  }
}
