import { backlinkPageSchema, DEFAULT_PAGE_LIMIT, type Backlink } from '@16bit/core'
import { ref } from 'vue'
import { asRequestError, getJson, type ApiRequestError, type Fetch } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'

export interface BacklinkList {
  entries: Backlink[]
  /** Links from items the reader cannot see, up to `MAX_HIDDEN_BACKLINKS`. */
  hidden: number
  nextCursor: string | null
  /** A "Show more" request is running. */
  more: boolean
  moreError: ApiRequestError | null
}

/**
 * The items that link to one item (`GET /items/:itemId/backlinks`), page by page. Only items
 * the reader can see are listed; the others are a count.
 */
export function useBacklinks(
  workspaceId: string,
  itemId: string,
  fetchFn: Fetch = (...args) => fetch(...args),
) {
  const list = ref<Load<BacklinkList>>({ state: 'loading' })
  const path = (cursor: string | null) => {
    const query = new URLSearchParams({ limit: String(DEFAULT_PAGE_LIMIT) })
    if (cursor) query.set('cursor', cursor)
    return `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/backlinks?${query.toString()}`
  }
  let generation = 0

  async function load() {
    const gen = ++generation
    list.value = { state: 'loading' }
    try {
      const page = await getJson(path(null), backlinkPageSchema, fetchFn)
      if (gen !== generation) return
      list.value = {
        state: 'ready',
        data: {
          entries: page.items,
          hidden: page.hidden,
          nextCursor: page.nextCursor,
          more: false,
          moreError: null,
        },
      }
    } catch (thrown) {
      if (gen === generation) list.value = { state: 'error', error: asRequestError(thrown) }
    }
  }

  async function loadMore() {
    const gen = generation
    const current = list.value
    if (current.state !== 'ready' || !current.data.nextCursor || current.data.more) return
    const data = current.data
    data.more = true
    data.moreError = null
    try {
      const page = await getJson(path(data.nextCursor), backlinkPageSchema, fetchFn)
      if (gen !== generation) return
      const key = (b: Backlink) => `${b.item.id}/${b.attributeId}`
      const known = new Set(data.entries.map(key))
      data.entries.push(...page.items.filter((b) => !known.has(key(b))))
      data.nextCursor = page.nextCursor
      data.hidden = page.hidden
    } catch (thrown) {
      if (gen === generation) data.moreError = asRequestError(thrown)
    } finally {
      if (gen === generation) data.more = false
    }
  }

  return { list, load, loadMore }
}
