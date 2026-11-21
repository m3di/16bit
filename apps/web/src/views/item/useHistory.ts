import { DEFAULT_PAGE_LIMIT, revisionPageSchema, type RevisionEntry } from '@16bit/core'
import { ref } from 'vue'
import { asRequestError, getJson, type ApiRequestError, type Fetch } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'

export interface HistoryList {
  /** Newest first. */
  entries: RevisionEntry[]
  nextCursor: string | null
  /** A "Show older" request is running. */
  more: boolean
  moreError: ApiRequestError | null
  /** Newer changes could not be read after the item changed. */
  refreshError: ApiRequestError | null
}

/**
 * An item's history (`GET /items/:itemId/revisions`), newest first, page by page. `refresh`
 * reads the first page again after the item changed and puts the new entries on top.
 */
export function useHistory(
  workspaceId: string,
  itemId: string,
  fetchFn: Fetch = (...args) => fetch(...args),
) {
  const list = ref<Load<HistoryList>>({ state: 'loading' })
  const path = (cursor: string | null) => {
    const query = new URLSearchParams({ limit: String(DEFAULT_PAGE_LIMIT) })
    if (cursor) query.set('cursor', cursor)
    return `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/revisions?${query.toString()}`
  }
  let generation = 0
  let refreshing: Promise<void> | null = null
  /** Another refresh was asked for while one ran. */
  let again = false
  const takeAgain = () => {
    const asked = again
    again = false
    return asked
  }

  async function load() {
    const gen = ++generation
    list.value = { state: 'loading' }
    try {
      const page = await getJson(path(null), revisionPageSchema, fetchFn)
      if (gen !== generation) return
      list.value = {
        state: 'ready',
        data: {
          entries: page.items,
          nextCursor: page.nextCursor,
          more: false,
          moreError: null,
          refreshError: null,
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
      const page = await getJson(path(data.nextCursor), revisionPageSchema, fetchFn)
      if (gen !== generation) return
      const known = new Set(data.entries.map((e) => e.seq))
      data.entries.push(...page.items.filter((e) => !known.has(e.seq)))
      data.nextCursor = page.nextCursor
    } catch (thrown) {
      if (gen === generation) data.moreError = asRequestError(thrown)
    } finally {
      if (gen === generation) data.more = false
    }
  }

  /** The newest version the history holds, or null before it is loaded. */
  function newestVersion(): number | null {
    return list.value.state === 'ready' ? (list.value.data.entries[0]?.version ?? 0) : null
  }

  async function readNewer() {
    const gen = generation
    const current = list.value
    if (current.state !== 'ready') return
    const data = current.data
    try {
      const page = await getJson(path(null), revisionPageSchema, fetchFn)
      if (gen !== generation) return
      data.refreshError = null
      const newest = data.entries[0]?.seq ?? 0
      const fresh = page.items.filter((e) => e.seq > newest)
      if (fresh.length === page.items.length && page.nextCursor) {
        // More changes than one page since the last read: start again from this page.
        data.entries = page.items
        data.nextCursor = page.nextCursor
        data.moreError = null
      } else {
        data.entries.unshift(...fresh)
      }
    } catch (thrown) {
      if (gen === generation) data.refreshError = asRequestError(thrown)
    }
  }

  /**
   * Reads changes newer than those shown. Calls while one runs are joined into one more read
   * after it, so the last change is never missed.
   */
  async function refresh() {
    if (list.value.state !== 'ready') return
    if (refreshing) {
      again = true
      return refreshing
    }
    refreshing = (async () => {
      again = false
      do await readNewer()
      while (takeAgain())
    })()
    try {
      await refreshing
    } finally {
      refreshing = null
    }
  }

  return { list, load, loadMore, refresh, newestVersion }
}
