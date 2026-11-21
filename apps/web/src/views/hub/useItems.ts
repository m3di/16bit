import {
  attributeTypes,
  conflictErrorSchema,
  DEFAULT_PAGE_LIMIT,
  itemQueryResultSchema,
  itemReadSchema,
  itemWriteResultSchema,
  type Attribute,
  type Item,
  type ItemQueryResult,
  type ItemWriteResult,
  type ItemValues,
  type ValueError,
} from '@16bit/core'
import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import {
  ApiRequestError,
  asRequestError,
  getJson,
  noContent,
  sendJson,
  type Fetch,
} from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'
import { workspaceStore, type AppliedChange, type WorkspaceStore } from '../../sync/store.ts'
import { listValue, type LinkedState } from './relations.ts'

/** Direct reads of linked items running at once, until #73 lets one request cover them. */
export const LINKED_READ_LIMIT = 6

/** One sort key, as the table offers it. The query endpoint takes up to three. */
export interface SortKey {
  attribute: string
  direction: 'asc' | 'desc'
}

export interface ItemList {
  ids: string[]
  nextCursor: string | null
  /** A "load more" request is running. */
  more: boolean
  moreError: ApiRequestError | null
  /**
   * "Load more" was refused because the server no longer sorts by `sort`. The cursor is not
   * retried; the rest can only be read after reloading in the default order.
   */
  moreRefused: boolean
  /** The order `ids` are in, which `nextCursor` belongs to. `null` is newest update first. */
  sort: SortKey | null
  /** A request for another order is running; the rows shown are still in `sort` order. */
  sorting: boolean
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
}

/**
 * Items of one hub as a view sees them: the selected folder's list, single items opened by ID,
 * and writes. Items live in the workspace store (D60); this keeps the order of the list and
 * what the view has read. Writes are optimistic: they sit in the store's pending layer with a
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

  let generation = 0
  const queues = new Map<string, Promise<unknown>>()
  const opening = new Map<string, Promise<Load<Item>>>()
  /** Items opened by ID (the panel, the item page), read again on a resync. */
  const opened = new Set<string>()

  const label = (item: Item | undefined) =>
    item && !store.isCreating(item.id) ? `${idPrefix()}-${String(item.seqId)}` : 'the new item'

  /** An item as shown: the server copy with pending writes applied in order. */
  const view = (id: string): Item | undefined => store.view(id)

  const rows = computed(() =>
    list.value.state === 'ready'
      ? list.value.data.ids.flatMap((id) => {
          const item = view(id)
          return item ? [item] : []
        })
      : [],
  )

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

  async function fetchPage(folder: string, cursor: string | null, order: SortKey | null) {
    const attributes = expand
    const page = await sendJson(
      'POST',
      `${base}/query`,
      {
        from: folder,
        limit: DEFAULT_PAGE_LIMIT,
        cursor,
        expand: attributes,
        sort: order ? [order] : [],
      },
      itemQueryResultSchema,
      fetchFn,
    )
    for (const item of page.items) absorb(item)
    noteRead(options.hubId?.() ?? page.items[0]?.hubId, page.seq)
    absorbLinked(page, attributes)
    return page
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

  const firstPage = (page: ItemQueryResult, order: SortKey | null): Load<ItemList> => ({
    state: 'ready',
    data: {
      ids: page.items.map((i) => i.id),
      nextCursor: page.nextCursor,
      more: false,
      moreError: null,
      moreRefused: false,
      sort: order,
      sorting: false,
    },
  })

  const staleSortNotice =
    'The table can no longer be sorted by that column, so the items are shown newest update first.'
  const moreRefusedNotice =
    'The table can no longer be sorted by that column, so no more items can be loaded in this order. Show them newest update first to see the rest.'

  /**
   * Reads the open folder's first page in the order asked for, from the loading state. If the
   * server refuses the sort, the sort is dropped and the default order is read instead, so a
   * retry never sends the refused sort again. `dropped` says a refused sort was just dropped:
   * the notice says so once the default order is shown, and not before.
   */
  async function reload(dropped = false) {
    const gen = ++generation
    const folder = folderId.value
    if (!folder) return
    const order = sort.value
    list.value = { state: 'loading' }
    try {
      const page = await fetchPage(folder, null, order)
      if (gen !== generation) return
      list.value = firstPage(page, order)
      if (dropped) say(staleSortNotice, true)
    } catch (thrown) {
      if (gen !== generation) return
      const error = asRequestError(thrown)
      if (order && refusedSort(error)) {
        sort.value = null
        await reload(true)
        return
      }
      list.value = { state: 'error', error }
    }
  }

  /**
   * Shows a folder's first page. `expandIds` are relation attributes whose linked items come
   * back with each page. Another folder starts in the default order, newest update first; the
   * same folder keeps its order while the attribute is among `sortableIds`, the folder's
   * columns that pass `canSort`.
   */
  async function openFolder(
    id: string,
    expandIds: readonly string[] = [],
    sortableIds?: readonly string[],
  ) {
    let dropped = false
    if (id !== folderId.value) sort.value = null
    else if (sort.value && sortableIds && !sortableIds.includes(sort.value.attribute)) {
      sort.value = null
      dropped = true
    }
    folderId.value = id
    expand = [...expandIds]
    await reload(dropped)
  }

  /**
   * Shows the folder in another order. The header shows the new order at once and the rows
   * stay until the sorted page arrives. If the server refuses, the order the rows are in comes
   * back and the notice says why.
   */
  async function setSort(next: SortKey | null) {
    sort.value = next
    const current = list.value
    const folder = folderId.value
    if (current.state !== 'ready' || !folder) {
      await reload()
      return
    }
    const gen = ++generation
    const data = current.data
    // A page still loading for the old order is dropped with the old generation.
    data.more = false
    data.moreError = null
    data.sorting = true
    try {
      const page = await fetchPage(folder, null, next)
      if (gen !== generation) return
      list.value = firstPage(page, next)
      // The rows are in the order asked for, so a notice about the previous order no longer applies.
      if (sortNotice) say(null)
    } catch (thrown) {
      if (gen !== generation) return
      const error = asRequestError(thrown)
      data.sorting = false
      sort.value = data.sort
      const reason = refusedSort(error)
        ? 'This column can no longer be sorted; reload the page to see the current columns.'
        : `The items could not be shown in that order. ${sentence(error.message)}`
      say(`${reason} The items are shown in the previous order.`, true)
    }
  }

  /**
   * Reads the next page in the order the rows are in. If the server no longer sorts by it,
   * the rows stay as they are and the cursor is not retried; the notice offers the default
   * order instead of replacing the rows unasked.
   */
  async function loadMore() {
    const gen = generation
    const current = list.value
    const folder = folderId.value
    if (
      current.state !== 'ready' ||
      !current.data.nextCursor ||
      current.data.more ||
      current.data.moreRefused ||
      current.data.sorting ||
      !folder
    )
      return
    const data = current.data
    data.more = true
    data.moreError = null
    try {
      // The cursor only fits the order its page came in.
      const page = await fetchPage(folder, data.nextCursor, data.sort)
      if (gen !== generation) return
      const known = new Set(data.ids)
      data.ids.push(...page.items.map((i) => i.id).filter((id) => !known.has(id)))
      data.nextCursor = page.nextCursor
    } catch (thrown) {
      if (gen !== generation) return
      const error = asRequestError(thrown)
      if (data.sort && refusedSort(error)) {
        data.moreRefused = true
        say(moreRefusedNotice, true)
      } else data.moreError = error
    } finally {
      if (gen === generation) data.more = false
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
  function save(id: string, values: ItemValues): Promise<boolean> {
    // The server does not have the item yet, so there is nothing to PATCH.
    if (store.isCreating(id)) {
      say('The new item is still being saved. Edit it once it has been created.')
      return Promise.resolve(false)
    }
    const mutationId = newItemId()
    store.addPending(id, { kind: 'patch', mutationId, values })
    const drop = () => {
      store.dropPending(id, mutationId)
    }

    return enqueue(id, async () => {
      if (!store.pending(id).some((w) => w.mutationId === mutationId)) return false
      const before = store.get(id)
      if (!before) {
        drop()
        return false
      }
      try {
        const response = await sendJson(
          'PATCH',
          itemPath(id),
          { version: before.version, values, clientMutationId: mutationId },
          itemWriteResultSchema,
          fetchFn,
        )
        confirmed(response)
        drop()
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
   * Adds the item to the top of the list at once and creates it. The client picks the ID, so
   * the row keeps its identity when the server confirms it. On failure the row is removed.
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
    if (list.value.state === 'ready') list.value.data.ids.unshift(id)

    try {
      const response = await sendJson(
        'POST',
        `${base}/items`,
        { id, folderId: folder, values, clientMutationId: mutationId },
        itemWriteResultSchema,
        fetchFn,
      )
      const item = confirmed(response) ?? withoutSeq(response)
      return { ok: true, item }
    } catch (thrown) {
      const error = asRequestError(thrown)
      if (gen === generation && list.value.state === 'ready') {
        list.value.data.ids = list.value.data.ids.filter((x) => x !== id)
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

  /**
   * Deletes an item at the version shown, after any edit still on its way. The item is hidden
   * at once and comes back if the server refuses, with the reason. On a 409 the item shows its
   * current values and the message says so; a 404 means it is already gone, which is what was
   * asked.
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
    return enqueue(id, async (): Promise<RemoveResult> => {
      const before = store.get(id) ?? shown
      try {
        const query = `?version=${String(before.version)}&clientMutationId=${mutationId}`
        await sendJson('DELETE', `${itemPath(id)}${query}`, undefined, noContent, fetchFn)
      } catch (thrown) {
        const error = asRequestError(thrown)
        const conflict = conflictErrorSchema.safeParse(error.body)
        if (!error.isNotFound) store.dropPending(id, mutationId)
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
      if (list.value.state === 'ready') {
        list.value.data.ids = list.value.data.ids.filter((x) => x !== id)
      }
      return { ok: true }
    })
  }

  /**
   * Keeps the list in step with the feed. A deleted item leaves it; an item that arrives in the
   * open folder and is not listed goes to the top, as the default order (newest update first)
   * puts it; a listed item updates in place. The echo of the reader's own create is already
   * listed, so it is not added twice (D59).
   */
  function onChange({ change }: AppliedChange) {
    const current = list.value
    if (current.state !== 'ready') return
    const data = current.data
    const listed = data.ids.includes(change.itemId)
    const item = store.get(change.itemId)
    if (!change.item || !item) {
      if (listed) data.ids = data.ids.filter((x) => x !== change.itemId)
      return
    }
    if (item.folderId !== folderId.value) {
      if (listed) data.ids = data.ids.filter((x) => x !== change.itemId)
      return
    }
    seen.add(item.id)
    if (!listed) data.ids.unshift(item.id)
  }

  /**
   * Too much was missed while away (D58): read the list and the items opened by ID again, so
   * their reads subscribe the hub afresh from their `seq`. The rows stay until the list arrives.
   */
  async function onResync(hubId: string) {
    if (!held.has(hubId)) return
    seen.clear()
    const ids = [...opened]
    for (const id of ids) void fetchItem(itemPath(id)).catch(() => undefined)
    const current = list.value
    const folder = folderId.value
    if (!hasList || !folder || current.state !== 'ready') return
    const gen = ++generation
    try {
      const page = await fetchPage(folder, null, current.data.sort)
      if (gen !== generation) return
      list.value = firstPage(page, current.data.sort)
    } catch {
      // The rows shown stay; the next change or reload brings the list back in step.
    }
  }

  const stops = [store.on('change', onChange), store.on('resync', (hubId) => void onResync(hubId))]
  /** Lets go of the store: listeners and live hubs. Runs on its own when the scope ends. */
  function dispose() {
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
    rows,
    folderId,
    sort,
    setSort,
    notice,
    view,
    isSaving,
    isCreating,
    label,
    openFolder,
    loadMore,
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
  }
}
