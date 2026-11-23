<script setup lang="ts">
import type { Block, HubDescription, Principal } from '@16bit/core'
import { computed } from 'vue'
import { ApiRequestError } from '../../api/client.ts'
import { shortId } from '../../ui/index.ts'
import { provideValueContext } from '../hub/context.ts'
import { provideViewHost } from '../root-view/host.ts'
import { readTree } from '../root-view/render-tree.ts'
import type { BlockLoad, DataProblem } from '../root-view/useRootView.ts'
import ViewRenderer from '../root-view/ViewRenderer.vue'
import { toTree, type DraftBlock } from './tree.ts'

// The draft as the folder will show it (Q10), with the renderer the hub page uses. Layout and
// content render as they are typed. Data blocks the stored view already has show its data;
// new or changed ones say they show their data once saved: the preview never makes up numbers.
const {
  draft,
  description,
  folderName,
  stored,
  unsaved,
  problem,
  workspaceId,
  me,
  people = [],
} = defineProps<{
  draft: DraftBlock
  description: HubDescription
  folderName: string
  /** The stored view's data, by block ID. */
  stored: Readonly<Record<string, BlockLoad>>
  unsaved: ReadonlySet<string>
  problem: DataProblem
  workspaceId: string
  me: string | null
  /** Names for actor values. */
  people?: readonly Principal[]
}>()

const itemLink = (item: { id: string; hubId: string; folderId: string }) => ({
  name: 'hub',
  params: { workspaceId, hubId: item.hubId, folderId: item.folderId },
  query: { item: item.id },
})
// Values in the preview are read-only: names from the member list, this hub's own items.
// Linked items of other hubs are not read here; they show as such, never as made-up labels.
provideValueContext({
  workspaceId,
  fetchFn: (...args) => fetch(...args),
  actor: (id) => {
    const p = people.find((x) => x.id === id)
    return p
      ? { id, name: p.name, kind: 'person', known: true }
      : { id, name: shortId(id), kind: 'person', known: false }
  },
  actorChoices: () => people.map((p) => ({ id: p.id, name: p.name, kind: 'person' as const })),
  members: () => ({ state: 'ready' }),
  retryMembers: () => undefined,
  linkState: () => ({ access: 'unknown' }),
  resolveLinked: () => undefined,
  rememberLinked: () => undefined,
  hub: (hubId) =>
    hubId === description.hub.id
      ? { state: 'ready', data: description }
      : { state: 'error', error: new ApiRequestError('not_found', 'Not read in the preview', 404) },
  hubLookup: (hubId) => (hubId === description.hub.id ? description : 'error'),
  ensureHubs: () => undefined,
  retryHub: () => undefined,
  itemLink,
})

provideViewHost({
  description: () => description,
  current: (item) => item,
  itemLink,
  // "New item" is the folder page's: the preview creates nothing.
  canCreate: () => false,
  create: () => undefined,
  me: () => me,
})

const emit = defineEmits<{ retry: [] }>()

const page = computed(() => readTree(toTree(draft)).page)
const nameOf = (block: Block) => {
  const config = block.config as { label?: string; binding?: { folderId?: string } }
  if (config.label) return config.label
  const id = config.binding?.folderId
  const f = id
    ? description.hub.id === id
      ? description.hub
      : description.folders.find((x) => x.id === id)
    : undefined
  return f?.name ?? 'Items'
}
</script>

<template>
  <div class="min-w-0" data-composer-preview>
    <ViewRenderer
      :page="page"
      :folder-name="folderName"
      :blocks="stored"
      :problem="problem"
      :name-of="nameOf"
      :unsaved="unsaved"
      @retry="emit('retry')"
    />
  </div>
</template>
