import { hubDescriptionSchema, type HubDescription } from '@16bit/core'
import { ref } from 'vue'
import { asRequestError, getJson, type Fetch } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'

/**
 * Descriptions of the hubs that relation values point into, read once each. The open hub is
 * seeded from the page. A hub the reader cannot see answers 404 (docs/ROLES.md) and stays an
 * error here; nothing about it is shown.
 */
export function useHubDirectory(workspaceId: string, fetchFn: Fetch = (...args) => fetch(...args)) {
  const hubs = ref<Record<string, Load<HubDescription>>>({})

  function seed(description: HubDescription) {
    hubs.value[description.hub.id] = { state: 'ready', data: description }
  }

  /** Starts reading every hub in `ids` that is not known yet. */
  function ensure(ids: Iterable<string>) {
    for (const id of ids) {
      if (hubs.value[id]) continue
      hubs.value[id] = { state: 'loading' }
      const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/hubs/${encodeURIComponent(id)}`
      getJson(path, hubDescriptionSchema, fetchFn).then(
        (data) => {
          hubs.value[id] = { state: 'ready', data }
        },
        (error: unknown) => {
          hubs.value[id] = { state: 'error', error: asRequestError(error) }
        },
      )
    }
  }

  /** Reads a hub again after an error, for a retry button. */
  function retry(id: string) {
    Reflect.deleteProperty(hubs.value, id)
    ensure([id])
  }

  /** A hub as `chipView` wants it. Unknown hubs count as loading; call `ensure` for them. */
  function lookup(id: string): HubDescription | 'loading' | 'error' {
    const hub = hubs.value[id]
    if (!hub || hub.state === 'loading') return 'loading'
    return hub.state === 'ready' ? hub.data : 'error'
  }

  const get = (id: string): Load<HubDescription> => hubs.value[id] ?? { state: 'loading' }

  return { hubs, seed, ensure, retry, lookup, get }
}

export type HubDirectory = ReturnType<typeof useHubDirectory>
