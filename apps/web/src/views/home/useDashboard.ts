import {
  hubGrantSchema,
  hubPageSchema,
  workspacePageSchema,
  type HubListEntry,
  type Workspace,
} from '@16bit/core'
import { computed, ref } from 'vue'
import {
  asRequestError,
  getAllPages,
  putJson,
  type ApiRequestError,
  type Fetch,
} from '../../api/client.ts'

export type Load<T> =
  { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; error: ApiRequestError }

export interface WorkspaceEntry {
  workspace: Workspace
  /** Hubs the caller can open, and for owners and admins also those they cannot (`access: 'none'`). */
  hubs: Load<HubListEntry[]>
}

/**
 * A self-grant on its way, why it was refused, or `stale`: access was given but the hub list
 * could not be read again, so the card still says "No access". Keyed by `selfGrantKey`.
 */
export type SelfGrant = { state: 'busy' } | { state: 'error'; message: string } | { state: 'stale' }

export const selfGrantKey = (workspaceId: string, hubId: string) => `${workspaceId}/${hubId}`

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

  /** Self-grants by owners and admins from a "no access" card. */
  const selfGrants = ref(new Map<string, SelfGrant>())

  /** Reads a workspace's hubs. `keep` leaves the list on screen while it is read again. */
  async function loadHubs(entry: WorkspaceEntry, gen: number, keep = false): Promise<boolean> {
    if (!(keep && entry.hubs.state === 'ready')) entry.hubs = { state: 'loading' }
    const path = `/v1/workspaces/${encodeURIComponent(entry.workspace.id)}/hubs`
    try {
      const hubs = await getAllPages(path, hubPageSchema, fetchFn)
      if (gen !== generation) return false
      entry.hubs = { state: 'ready', data: hubs }
      // The list now shows every grant given, so no card waits for a reload any more.
      const prefix = selfGrantKey(entry.workspace.id, '')
      for (const [key, ask] of selfGrants.value) {
        if (ask.state === 'stale' && key.startsWith(prefix)) selfGrants.value.delete(key)
      }
      return true
    } catch (error) {
      if (gen === generation && !(keep && entry.hubs.state === 'ready')) {
        entry.hubs = { state: 'error', error: asRequestError(error) }
      }
      return false
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
      // Keeps a list on screen (after a self-grant); an error state goes to loading as before.
      running = loadHubs(entry, generation, true)
        .then(() => undefined)
        .finally(() => loadingHubs.delete(workspaceId))
      loadingHubs.set(workspaceId, running)
    }
    await running
  }

  /**
   * An owner or admin gives themselves hub admin access to a hub they see as "no access"
   * (docs/ROLES.md, D45). The API logs it in `access_log` (D48). The card turns into a link once
   * the hub list is read again, since only that read carries the hub's item count. If that read
   * fails, the grant is `stale` and the card says so, with a way to read the list again.
   */
  async function grantSelf(workspaceId: string, hubId: string, principalId: string) {
    const key = selfGrantKey(workspaceId, hubId)
    if (selfGrants.value.get(key)?.state === 'busy') return
    selfGrants.value.set(key, { state: 'busy' })
    const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/hubs/${encodeURIComponent(hubId)}/grants/${encodeURIComponent(principalId)}`
    try {
      await putJson(path, { hubRole: 'hub_admin' }, hubGrantSchema, fetchFn)
    } catch (raw) {
      const error = asRequestError(raw)
      selfGrants.value.set(key, {
        state: 'error',
        message: error.isNoPermission
          ? 'Your role does not allow giving yourself access.'
          : error.isNotFound
            ? 'This hub is no longer available.'
            : `Access was not given. ${error.message}`,
      })
      return
    }
    const entry =
      workspaces.value.state === 'ready'
        ? workspaces.value.data.find((e) => e.workspace.id === workspaceId)
        : undefined
    if (!entry || (await loadHubs(entry, generation, true))) selfGrants.value.delete(key)
    else selfGrants.value.set(key, { state: 'stale' })
  }

  function dismissSelfGrant(workspaceId: string, hubId: string) {
    selfGrants.value.delete(selfGrantKey(workspaceId, hubId))
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

  return { workspaces, totals, selfGrants, load, reloadHubs, grantSelf, dismissSelfGrant }
}
