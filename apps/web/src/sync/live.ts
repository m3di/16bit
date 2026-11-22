import { computed, getCurrentScope, onScopeDispose } from 'vue'
import type { WorkspaceStore } from './store.ts'

/** How long a burst of item changes is gathered before the hub's counts are read again. In ms. */
export const COUNTS_DELAY = 500

/**
 * What a page does with feed events about its hub (D58): `onSchema` runs on every `hub` event (its
 * `version` is informational: folder and attribute writes do not bump it), and
 * `lost` turns true on `access_lost`, for the no-permission state.
 *
 * `onCounts` reads the hub's folder counts again after its items change: a create or a delete
 * moves them, and no event carries the counts themselves. A change does not say whether it was a
 * create (a create and an edit made together arrive as one change), so every change in the hub
 * counts, gathered for `COUNTS_DELAY` so a burst costs one read, and one read at a time. A resync
 * may have missed creates and deletes, so it reads them too.
 */
export function useLiveHub(
  store: WorkspaceStore,
  hubId: () => string | null,
  onSchema: (hubId: string) => void,
  onCounts?: (hubId: string) => void | Promise<void>,
) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let reading = false
  let again = false
  let stopped = false

  async function readCounts() {
    timer = null
    const id = hubId()
    if (stopped || !onCounts || id === null) return
    reading = true
    try {
      await onCounts(id)
    } finally {
      reading = false
      if (again) {
        again = false
        countsSoon()
      }
    }
  }

  function countsSoon() {
    if (!onCounts || stopped) return
    if (reading) again = true
    else timer ??= setTimeout(() => void readCounts(), COUNTS_DELAY)
  }

  const stops = [
    store.on('hub', (id) => {
      if (id === hubId()) onSchema(id)
    }),
    store.on('change', (change) => {
      if (change.hubId === hubId()) countsSoon()
    }),
    store.on('resync', (id) => {
      if (id === hubId()) countsSoon()
    }),
  ]
  const stop = () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    for (const s of stops) s()
  }
  if (getCurrentScope()) onScopeDispose(stop)
  const lost = computed(() => {
    const id = hubId()
    return id !== null && store.isLost(id)
  })
  return { lost, stop }
}
