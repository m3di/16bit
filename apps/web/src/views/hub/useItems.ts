import {
  conflictErrorSchema,
  DEFAULT_PAGE_LIMIT,
  itemPageSchema,
  itemSchema,
  type Item,
  type ItemValues,
  type ValueError,
} from '@16bit/core'
import { computed, ref } from 'vue'
import { ApiRequestError, asRequestError, getJson, sendJson, type Fetch } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'

export interface ItemList {
  ids: string[]
  nextCursor: string | null
  /** A "load more" request is running. */
  more: boolean
  moreError: ApiRequestError | null
}

/** An edit applied locally and not yet confirmed by the server. */
interface PendingEdit {
  key: number
  values: ItemValues
}

export type CreateResult = { ok: true; item: Item } | { ok: false; error: ApiRequestError }

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

/**
 * Items of one hub: the selected folder's list, single items opened by ID, and writes.
 * The server's copy of each item is kept apart from local edits, so a rejected edit rolls
 * back by dropping it, and a 409 replaces the server copy with the item as it is now.
 */
export function useItems(
  workspaceId: string,
  idPrefix: () => string,
  fetchFn: Fetch = (...args) => fetch(...args),
) {
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

  async function fetchPage(folder: string, cursor: string | null) {
    const page = await sendJson(
      'POST',
      `${base}/query`,
      { from: folder, limit: DEFAULT_PAGE_LIMIT, cursor },
      itemPageSchema,
      fetchFn,
    )
    for (const item of page.items) server.value[item.id] = item
    return page
  }

  /** Shows a folder's first page, newest update first. */
  async function openFolder(id: string) {
    const gen = ++generation
    folderId.value = id
    list.value = { state: 'loading' }
    try {
      const page = await fetchPage(id, null)
      if (gen !== generation) return
      list.value = {
        state: 'ready',
        data: {
          ids: page.items.map((i) => i.id),
          nextCursor: page.nextCursor,
          more: false,
          moreError: null,
        },
      }
    } catch (error) {
      if (gen === generation) list.value = { state: 'error', error: asRequestError(error) }
    }
  }

  async function loadMore() {
    const gen = generation
    const current = list.value
    const folder = folderId.value
    if (current.state !== 'ready' || !current.data.nextCursor || current.data.more || !folder)
      return
    const data = current.data
    data.more = true
    data.moreError = null
    try {
      const page = await fetchPage(folder, data.nextCursor)
      if (gen !== generation) return
      const known = new Set(data.ids)
      data.ids.push(...page.items.map((i) => i.id).filter((id) => !known.has(id)))
      data.nextCursor = page.nextCursor
    } catch (error) {
      if (gen === generation) data.moreError = asRequestError(error)
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
      running = getJson(itemPath(id), itemSchema, fetchFn)
        .then((item): Load<Item> => {
          server.value[item.id] = item
          return { state: 'ready', data: item }
        })
        .catch((error: unknown): Load<Item> => ({ state: 'error', error: asRequestError(error) }))
        .finally(() => opening.delete(id))
      opening.set(id, running)
    }
    return running
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
          itemSchema,
          fetchFn,
        )
        server.value[id] = updated
        drop()
        return true
      } catch (thrown) {
        const error = asRequestError(thrown)
        const conflict = conflictErrorSchema.safeParse(error.body)
        if (error.code === 'conflict' && conflict.success) {
          server.value[id] = conflict.data.current
          pending.value[id] = []
          notice.value = `${label(before)} was changed by someone else before your edit was saved. Your edit was not applied; the latest values are shown.`
        } else {
          drop()
          notice.value = `Your change to ${label(before)} was not saved. ${error.message}`
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
    const id = crypto.randomUUID()
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
        itemSchema,
        fetchFn,
      )
      server.value[id] = item
      return { ok: true, item }
    } catch (thrown) {
      const error = asRequestError(thrown)
      Reflect.deleteProperty(server.value, id)
      if (gen === generation && list.value.state === 'ready') {
        list.value.data.ids = list.value.data.ids.filter((x) => x !== id)
      }
      notice.value = `The item was not created. ${error.message}`
      return { ok: false, error }
    } finally {
      Reflect.deleteProperty(creating.value, id)
    }
  }

  const dismissNotice = () => {
    notice.value = null
  }

  return {
    list,
    rows,
    folderId,
    notice,
    view,
    isSaving,
    isCreating,
    label,
    openFolder,
    loadMore,
    openItem,
    save,
    create,
    dismissNotice,
  }
}
