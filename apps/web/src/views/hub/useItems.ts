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
  type ItemValues,
  type ValueError,
} from '@16bit/core'
import { computed, ref } from 'vue'
import {
  ApiRequestError,
  asRequestError,
  getJson,
  noContent,
  sendJson,
  type Fetch,
} from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'
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

/** An edit applied locally and not yet confirmed by the server. */
interface PendingEdit {
  key: number
  values: ItemValues
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
 * A response without the workspace `seq` it carries (D58, issue 181), so the store holds
 * items only. The API sends `seq` from M3-03; until then this changes nothing.
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

/**
 * Items of one hub: the selected folder's list, single items opened by ID, and writes.
 * The server's copy of each item is kept apart from local edits, so a rejected edit rolls
 * back by dropping it, and a 409 replaces the server copy with the item as it is now.
 *
 * `options.list: false` is for a page without a folder list (the item page): linked items are
 * then read without waiting for a list query that never comes.
 */
export function useItems(
  workspaceId: string,
  idPrefix: () => string,
  fetchFn: Fetch = (...args) => fetch(...args),
  options: { list?: boolean } = {},
) {
  const hasList = options.list ?? true
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId)}`
  const itemPath = (id: string) => `${base}/items/${encodeURIComponent(id)}`

  /** Server copies by ID. */
  const server = ref<Record<string, Item>>({})
  const pending = ref<Record<string, PendingEdit[]>>({})
  /** Items created locally and not yet confirmed. */
  const creating = ref<Record<string, true>>({})
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
  let editKey = 0
  const queues = new Map<string, Promise<unknown>>()
  const opening = new Map<string, Promise<Load<Item>>>()

  const label = (item: Item | undefined) =>
    item && !creating.value[item.id] ? `${idPrefix()}-${String(item.seqId)}` : 'the new item'

  /** An item as shown: the server copy with local edits applied in order. */
  function view(id: string): Item | undefined {
    const item = server.value[id]
    const edits = pending.value[id]
    if (!item || !edits?.length) return item
    const values = edits.reduce<ItemValues>((acc, e) => ({ ...acc, ...e.values }), item.values)
    return { ...item, values }
  }

  const rows = computed(() =>
    list.value.state === 'ready'
      ? list.value.data.ids.flatMap((id) => {
          const item = view(id)
          return item ? [item] : []
        })
      : [],
  )

  const isCreating = (id: string) => Boolean(creating.value[id])
  const isSaving = (id: string) => Boolean(pending.value[id]?.length || creating.value[id])

  /**
   * Keeps what an expanded page says about its linked items. An ID in an expanded value with
   * no entry was deleted, unless the server cut `linked` short.
   */
  function absorbLinked(page: ItemQueryResult, attributes: readonly string[]) {
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
    for (const item of page.items) server.value[item.id] = item
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

  /** Makes sure an item is in the store, fetching it if it is not in the loaded list. */
  function openItem(id: string): Promise<Load<Item>> {
    const known = server.value[id]
    if (known) return Promise.resolve({ state: 'ready', data: known })
    let running = opening.get(id)
    if (!running) {
      running = getJson(itemPath(id), itemReadSchema, fetchFn)
        .then((read): Load<Item> => {
          const item = withoutSeq(read)
          server.value[item.id] = item
          return { state: 'ready', data: item }
        })
        .catch((error: unknown): Load<Item> => ({ state: 'error', error: asRequestError(error) }))
        .finally(() => opening.delete(id))
      opening.set(id, running)
    }
    return running
  }

  /**
   * Reads an item again with `expand` (relation attributes, at most `MAX_EXPAND_ATTRIBUTES`),
   * so its linked items arrive with it, as with a folder query. The server copy is replaced
   * unless a newer version is already known.
   */
  async function readItem(id: string, expandIds: readonly string[]): Promise<Load<Item>> {
    const query =
      expandIds.length > 0 ? `?expand=${expandIds.map(encodeURIComponent).join(',')}` : ''
    try {
      const {
        linked: links,
        linkedTruncated,
        ...read
      } = await getJson(`${itemPath(id)}${query}`, itemReadSchema, fetchFn)
      const item = withoutSeq(read)
      const known = server.value[id]
      if (!known || known.version <= item.version) server.value[id] = item
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

  /**
   * Applies `values` at once and saves them. Resolves `true` when the server accepted them.
   * On a 409 the item shows the server's current values, and every edit still queued for it
   * is dropped, since it was made against the old version. Any other failure undoes this edit.
   */
  function save(id: string, values: ItemValues): Promise<boolean> {
    // The server does not have the item yet, so there is nothing to PATCH.
    if (creating.value[id]) {
      say('The new item is still being saved. Edit it once it has been created.')
      return Promise.resolve(false)
    }
    const edit: PendingEdit = { key: ++editKey, values }
    pending.value[id] = [...(pending.value[id] ?? []), edit]
    const drop = () => {
      pending.value[id] = (pending.value[id] ?? []).filter((e) => e.key !== edit.key)
    }

    return enqueue(id, async () => {
      if (!pending.value[id]?.some((e) => e.key === edit.key)) return false
      const before = server.value[id]
      if (!before) {
        drop()
        return false
      }
      try {
        const updated = await sendJson(
          'PATCH',
          itemPath(id),
          { version: before.version, values },
          itemWriteResultSchema,
          fetchFn,
        ).then(withoutSeq)
        server.value[id] = updated
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
          server.value[id] = conflict.data.current
          pending.value[id] = []
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
    const placeholder: Item = {
      workspaceId,
      id,
      hubId: '',
      folderId: folder,
      seqId: 1,
      values,
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: '',
    }
    server.value[id] = placeholder
    creating.value[id] = true
    const gen = generation
    if (list.value.state === 'ready') list.value.data.ids.unshift(id)

    try {
      const item = await sendJson(
        'POST',
        `${base}/items`,
        { id, folderId: folder, values },
        itemWriteResultSchema,
        fetchFn,
      ).then(withoutSeq)
      server.value[id] = item
      return { ok: true, item }
    } catch (thrown) {
      const error = asRequestError(thrown)
      Reflect.deleteProperty(server.value, id)
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
      Reflect.deleteProperty(creating.value, id)
    }
  }

  /**
   * Deletes an item at the version shown, after any edit still on its way. Nothing is removed
   * from view until the server agrees: the caller leaves the item's page on success. On a 409
   * the item shows its current values and the message says so; a 404 means it is already gone,
   * which is what was asked.
   */
  function remove(id: string): Promise<RemoveResult> {
    if (creating.value[id]) {
      return Promise.resolve({
        ok: false,
        message: 'The new item is still being saved. Delete it once it has been created.',
      })
    }
    return enqueue(id, async (): Promise<RemoveResult> => {
      const before = server.value[id]
      if (!before) return { ok: false, message: 'This item is not loaded.' }
      try {
        await sendJson(
          'DELETE',
          `${itemPath(id)}?version=${String(before.version)}`,
          undefined,
          noContent,
          fetchFn,
        )
      } catch (thrown) {
        const error = asRequestError(thrown)
        const conflict = conflictErrorSchema.safeParse(error.body)
        if (error.isNotFound) {
          // Fall through: it is gone either way.
        } else if (error.status === 403) {
          readOnly.value = true
          return {
            ok: false,
            message: `${label(before)} was not deleted. You can view the items in this hub but not change them.`,
          }
        } else if (error.code === 'conflict' && conflict.success) {
          server.value[id] = conflict.data.current
          pending.value[id] = []
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
      if (list.value.state === 'ready') {
        list.value.data.ids = list.value.data.ids.filter((x) => x !== id)
      }
      return { ok: true }
    })
  }

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
  }
}
