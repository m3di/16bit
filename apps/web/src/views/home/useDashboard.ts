import { hubPageSchema, workspacePageSchema, type Folder, type Workspace } from '@16bit/core'
import { computed, ref } from 'vue'
import { ApiRequestError, getAllPages, type Fetch } from '../../api/client.ts'

export type Load<T> =
  { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; error: ApiRequestError }

export interface WorkspaceEntry {
  workspace: Workspace
  hubs: Load<Folder[]>
}

const asRequestError = (error: unknown) =>
  error instanceof ApiRequestError
    ? error
    : new ApiRequestError('internal', error instanceof Error ? error.message : 'Unknown error')

/**
 * The main dashboard's data: the caller's workspaces, then each workspace's hubs in parallel.
 * A workspace whose hubs fail to load shows its own error; the others still render.
 */
export function useDashboard(fetchFn: Fetch = (...args) => fetch(...args)) {
  const workspaces = ref<Load<WorkspaceEntry[]>>({ state: 'loading' })
  let generation = 0

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

  async function load() {
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
    if (entry) await loadHubs(entry, generation)
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
