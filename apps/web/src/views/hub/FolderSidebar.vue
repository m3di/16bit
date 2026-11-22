<script setup lang="ts">
import type { Folder } from '@16bit/core'
import { computed } from 'vue'
import { StateBlock } from '../../ui/index.ts'
import type { SidebarAction, SidebarActionKey } from '../hub-settings/schema.ts'
import type { Load } from '../home/useDashboard.ts'
import FolderSidebarRow from './FolderSidebarRow.vue'
import type { FolderEntry } from './useHub.ts'

const props = defineProps<{
  workspaceId: string
  hubName: string | null
  tree: Load<FolderEntry[]>
  /** The open folder. */
  folderId: string
  /** `location` on an item's page: the folder is where the item is, not the page itself. */
  current?: 'page' | 'location'
  /** Each folder's actions menu. Left out, or empty for a folder, means no menu. */
  actionsFor?: (folder: Folder) => readonly SidebarAction[]
}>()

const emit = defineEmits<{ action: [folder: Folder, key: SidebarActionKey] }>()

// The hub's root folder holds the items directly in the hub (D2). It reads as the hub's own
// items, and every other folder is nested under it.
const entries = computed(() => (props.tree.state === 'ready' ? props.tree.data : []))
const root = computed(() => entries.value.find((e) => e.folder.id === e.folder.hubId) ?? null)
const folders = computed(() => entries.value.filter((e) => e !== root.value))

const linkTo = (entry: FolderEntry) => ({
  name: 'hub',
  params: {
    workspaceId: props.workspaceId,
    hubId: entry.folder.hubId,
    folderId: entry === root.value ? undefined : entry.folder.id,
  },
})
const currentOf = (entry: FolderEntry) =>
  entry.folder.id === props.folderId ? (props.current ?? 'page') : undefined
const actionsOf = (entry: FolderEntry): readonly SidebarAction[] =>
  props.actionsFor?.(entry.folder) ?? []
</script>

<template>
  <nav aria-label="Folders" class="flex flex-col gap-1">
    <span class="truncate px-2 pb-1 text-caption text-ink3">{{ hubName ?? 'Hub' }}</span>
    <StateBlock v-if="tree.state === 'loading'" state="loading" title="Loading folders" />
    <p v-else-if="tree.state === 'error'" class="m-0 px-2 text-secondary text-ink3">
      Folders are not available.
    </p>
    <ul v-else class="m-0 flex list-none flex-col gap-px p-0">
      <li v-if="root">
        <FolderSidebarRow
          :to="linkTo(root)"
          :label="root.folder.name"
          :color="root.folder.color"
          :count="root.ownCount"
          :current="currentOf(root)"
          :indent="8"
          :actions="actionsOf(root)"
          :actions-label="`Actions for ${root.folder.name}`"
          root
          @action="emit('action', root.folder, $event)"
        />
        <!-- Nested under the hub: a hairline guide from the hub's square down. -->
        <ul
          v-if="folders.length > 0"
          class="m-0 mt-px ml-3 flex list-none flex-col gap-px border-l border-line p-0"
        >
          <li v-for="entry in folders" :key="entry.folder.id">
            <FolderSidebarRow
              :to="linkTo(entry)"
              :label="entry.folder.name"
              :color="entry.folder.color"
              :count="entry.ownCount"
              :current="currentOf(entry)"
              :indent="8 + entry.depth * 12"
              :actions="actionsOf(entry)"
              :actions-label="`Actions for ${entry.folder.name}`"
              @action="emit('action', entry.folder, $event)"
            />
          </li>
        </ul>
      </li>
    </ul>
  </nav>
</template>
