import { hubPageSchema, workspacePageSchema, type HubListEntry, type Workspace } from '@16bit/core'
import { computed, ref } from 'vue'
import { asRequestError, getAllPages, type ApiRequestError, type Fetch } from '../../api/client.ts'

export type Load<T> =
  { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; error: ApiRequestError }

export interface WorkspaceEntry {
  workspace: Workspace
  /** Hubs the caller can open, and for owners and admins also those they cannot (`access: 'none'`). */
  hubs: Load<HubListEntry[]>
}

/**
 * The main dashboard's data: the caller's workspaces, then each workspace's hubs in parallel.
 * A workspace whose hubs fail to load shows its own error; the others still render.
 */
export function useDashboard(fetchFn: Fetch = (...args) => fetch(...args)) {
  const workspaces = ref<Load<WorkspaceEntry[]>>({ state: 'loading' })
  let generation = 0
  // A second "Try again" while a load is running joins it instead of sending another request.
  let loading: Promise<void> | null = null
  const loadingHubs = new Map<string, Promise<void>>()

  async function loadHubs(entry: WorkspaceEntry, gen: number) {
    entry.hubs = { state: 'loading' }
    const path = `/v1/workspaces/${encodeURIComponent(entry.workspace.id)}/hubs`
    try {
      const hubs = await getAllPages(path, hubPageSchema, fetchFn)
      if (gen === generation) entry.hubs = { state: 'ready', data: hubs }
    } catch (error) {
      if (gen === generation) entry.hubs = { state: 'error', error: asRequestError(error) }
    }
  }

  function load(): Promise<void> {
    loading ??= fetchAll().finally(() => {
      loading = null
    })
    return loading
  }

  async function fetchAll() {
    const gen = ++generation
    workspaces.value = { state: 'loading' }
    let list: Workspace[]
    try {
      list = await getAllPages('/v1/workspaces', workspacePageSchema, fetchFn)
    } catch (error) {
      if (gen === generation) workspaces.value = { state: 'error', error: asRequestError(error) }
      return
    }
    if (gen !== generation) return
    workspaces.value = {
      state: 'ready',
      data: list.map((workspace) => ({ workspace, hubs: { state: 'loading' } })),
    }
    // Read the entries back through the ref so updates go through Vue's reactive proxy.
    await Promise.all(workspaces.value.data.map((entry) => loadHubs(entry, gen)))
  }

  async function reloadHubs(workspaceId: string) {
    if (workspaces.value.state !== 'ready') return
    const entry = workspaces.value.data.find((e) => e.workspace.id === workspaceId)
    if (!entry) return
    let running = loadingHubs.get(workspaceId)
    if (!running) {
      running = loadHubs(entry, generation).finally(() => loadingHubs.delete(workspaceId))
      loadingHubs.set(workspaceId, running)
    }
    await running
  }

  /** Hub and workspace totals, once every workspace's hubs have loaded. */
  const totals = computed(() => {
    const value = workspaces.value
    if (value.state !== 'ready') return null
    let hubs = 0
    for (const entry of value.data) {
      if (entry.hubs.state !== 'ready') return null
      hubs += entry.hubs.data.length
    }
    return { hubs, workspaces: value.data.length }
  })

  return { workspaces, totals, load, reloadHubs }
}
