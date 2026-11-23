import type { BlockData, HubDescription, Item, LinkedItem } from '@16bit/core'
import { computed } from 'vue'
import { useOptionalValueContext } from '../../hub/context.ts'
import { linkedLabel, type Names } from '../format.ts'
import { useViewHost } from '../host.ts'
import { stateOf } from '../registry.ts'
import type { BlockLoad } from '../useRootView.ts'

/** A data block's state, its data when it is `ok` and of `kind`, and what it shows with. */
export function useBlock<K extends BlockData['kind']>(
  load: () => BlockLoad | null | undefined,
  kind: K,
) {
  const host = useViewHost()
  const values = useOptionalValueContext()
  const data = computed(() => {
    const l = load()
    if (l?.state !== 'ready' || l.status.status !== 'ok') return null
    const d = l.status.data
    return d.kind === kind ? (d as Extract<BlockData, { kind: K }>) : null
  })
  const state = computed(() => {
    const s = stateOf(load() ?? undefined)
    // An answer of another kind than the block reads is a fault, not data.
    return s === 'ready' && !data.value ? 'error' : s
  })

  const hubOf = (hubId: string): HubDescription | null => {
    const d = host.description()
    if (d?.hub.id === hubId) return d
    const found = values?.hubLookup(hubId)
    return typeof found === 'object' ? found : null
  }
  const linked = computed(
    () =>
      ((data.value as { linked?: Record<string, LinkedItem> } | null)?.linked ?? undefined) as
        | Readonly<Record<string, LinkedItem>>
        | undefined,
  )
  const names: Names = {
    actor: (id) => values?.actor(id).name ?? id.slice(0, 8),
    item: (id) => linkedLabel(id, linked.value, hubOf),
  }

  /** Items as the store shows them now, so edits show in place; gone ones drop out (D60). */
  const current = (items: readonly Item[]): Item[] =>
    items.flatMap((item) => {
      const now = host.current(item)
      return now ? [now] : []
    })

  return { host, data, state, names, current, description: () => host.description() }
}
