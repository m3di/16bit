import { computed, getCurrentScope, onScopeDispose } from 'vue'
import type { WorkspaceStore } from './store.ts'

/**
 * What a page does with feed events about its hub (D58): `onSchema` runs on every `hub` event (its
 * `version` is informational: folder and attribute writes do not bump it), and
 * `lost` turns true on `access_lost`, for the no-permission state.
 */
export function useLiveHub(
  store: WorkspaceStore,
  hubId: () => string | null,
  onSchema: (hubId: string) => void,
) {
  const stop = store.on('hub', (id) => {
    if (id === hubId()) onSchema(id)
  })
  if (getCurrentScope()) onScopeDispose(stop)
  const lost = computed(() => {
    const id = hubId()
    return id !== null && store.isLost(id)
  })
  return { lost, stop }
}
