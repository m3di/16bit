import { computed, getCurrentScope, onScopeDispose } from 'vue'
import type { WorkspaceStore } from './store.ts'

/**
 * Whether a schema change announced by a feed `hub` event should be read. The event carries the
 * hub's version; one older than the description shown is late and changes nothing. An equal one
 * is read too, so a schema change that leaves the hub's own version alone is not missed.
 */
export const hubEventIsNew = (shown: number, announced: number) => announced >= shown

/**
 * What a page does with feed events about its hub (D58): `onSchema` runs on a `hub` event, and
 * `lost` turns true on `access_lost`, for the no-permission state.
 */
export function useLiveHub(
  store: WorkspaceStore,
  hubId: () => string | null,
  onSchema: (hubId: string, version: number) => void,
) {
  const stop = store.on('hub', (id, version) => {
    if (id === hubId()) onSchema(id, version)
  })
  if (getCurrentScope()) onScopeDispose(stop)
  const lost = computed(() => {
    const id = hubId()
    return id !== null && store.isLost(id)
  })
  return { lost, stop }
}
