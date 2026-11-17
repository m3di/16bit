import { itemPageSchema, type Filter, type HubDescription, type Item } from '@16bit/core'
import { computed, ref } from 'vue'
import { asRequestError, sendJson, type ApiRequestError, type Fetch } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'
import { displayId, itemTitle, titleAttribute } from './relations.ts'
import { folderColumns } from './useHub.ts'

/** Items per page of picker results. */
export const PICKER_PAGE = 20

export interface Results {
  items: Item[]
  nextCursor: string | null
  more: boolean
  moreError: ApiRequestError | null
}

/**
 * Candidates for a relation, read through `POST /query` on one folder of the target hub. The
 * query only answers with items the reader can read, so the picker never offers others.
 *
 * Search runs on the server when the folder's title attribute is indexed (`contains`).
 * Otherwise the loaded pages are filtered here, and `local` says so, so the picker can say it
 * searched only what was loaded.
 */
export function useRelationSearch(
  workspaceId: string,
  target: () => HubDescription | null,
  fetchFn: Fetch,
) {
  const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/query`
  const folderId = ref<string | null>(null)
  const text = ref('')
  /** The text the shown results were searched for. */
  const searched = ref('')
  const results = ref<Load<Results> | null>(null)
  let generation = 0

  const folder = computed(() => folderId.value ?? target()?.hub.id ?? null)
  const title = computed(() => {
    const hub = target()
    return hub && folder.value ? titleAttribute(folderColumns(hub, folder.value)) : null
  })
  /** The server cannot filter on the title, so results are filtered among loaded pages. */
  const local = computed(() => !title.value?.indexed)

  function where(query: string): Filter | null {
    const t = title.value
    if (!query || !t?.indexed) return null
    return { attribute: t.id, op: 'contains', value: query }
  }

  const page = (from: string, query: string, cursor: string | null) =>
    sendJson(
      'POST',
      path,
      { from, where: where(query), limit: PICKER_PAGE, cursor },
      itemPageSchema,
      fetchFn,
    )

  async function search() {
    const from = folder.value
    if (!from) return
    const gen = ++generation
    const query = text.value.trim()
    results.value = { state: 'loading' }
    try {
      const first = await page(from, query, null)
      if (gen !== generation) return
      searched.value = query
      results.value = {
        state: 'ready',
        data: { items: first.items, nextCursor: first.nextCursor, more: false, moreError: null },
      }
    } catch (error) {
      if (gen === generation) results.value = { state: 'error', error: asRequestError(error) }
    }
  }

  async function loadMore() {
    const current = results.value
    const from = folder.value
    if (current?.state !== 'ready' || !current.data.nextCursor || current.data.more || !from) return
    const gen = generation
    const data = current.data
    data.more = true
    data.moreError = null
    try {
      const next = await page(from, searched.value, data.nextCursor)
      if (gen !== generation) return
      const known = new Set(data.items.map((i) => i.id))
      data.items.push(...next.items.filter((i) => !known.has(i.id)))
      data.nextCursor = next.nextCursor
    } catch (error) {
      if (gen === generation) data.moreError = asRequestError(error)
    } finally {
      if (gen === generation) data.more = false
    }
  }

  /** The results to offer, minus `exclude`, matched locally when the server could not. */
  function offered(exclude: readonly string[]): Item[] {
    const r = results.value
    const hub = target()
    if (r?.state !== 'ready' || !hub) return []
    const skip = new Set(exclude)
    const query = searched.value.toLowerCase()
    return r.data.items.filter((item) => {
      if (skip.has(item.id)) return false
      if (!local.value || !query) return true
      const name = itemTitle(item, folderColumns(hub, item.folderId)).toLowerCase()
      return name.includes(query) || displayId(hub, item).toLowerCase().includes(query)
    })
  }

  function setFolder(id: string) {
    folderId.value = id
    void search()
  }

  return { folderId, folder, text, searched, results, local, search, loadMore, offered, setFolder }
}
