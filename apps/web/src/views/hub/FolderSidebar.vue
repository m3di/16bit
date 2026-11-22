<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { StateBlock, paletteVar } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import type { FolderEntry } from './useHub.ts'

const props = defineProps<{
  workspaceId: string
  hubName: string | null
  tree: Load<FolderEntry[]>
  /** The open folder. */
  folderId: string
  /** `location` on an item's page: the folder is where the item is, not the page itself. */
  current?: 'page' | 'location'
}>()

// The hub's root folder holds the items directly in the hub (D2). It reads as the hub's own
// items, and every other folder is nested under it.
const entries = computed(() => (props.tree.state === 'ready' ? props.tree.data : []))
const root = computed(() => entries.value.find((e) => e.folder.id === e.folder.hubId) ?? null)
const folders = computed(() => entries.value.filter((e) => e !== root.value))

const format = new Intl.NumberFormat('en')
const countLabel = (n: number) => (n === 1 ? '1 item' : `${format.format(n)} items`)

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
const linkClass =
  'flex min-h-8 items-center gap-2 rounded-control pr-2 text-ink no-underline hover:bg-selected'
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
        <RouterLink
          :to="linkTo(root)"
          :aria-current="currentOf(root)"
          :class="[linkClass, 'pl-2', root.folder.id === folderId && 'bg-selected font-medium']"
          data-folder-link
          data-folder-root
        >
          <span
            aria-hidden="true"
            class="size-2 shrink-0"
            :style="{ background: paletteVar(root.folder.color) }"
          />
          <span class="min-w-0 flex-1 truncate">Items in {{ root.folder.name }}</span>
          <span
            v-if="root.ownCount !== null"
            class="text-caption text-ink3 tabular-nums"
            :aria-label="countLabel(root.ownCount)"
            data-folder-count
            >{{ format.format(root.ownCount) }}</span
          >
        </RouterLink>
        <!-- Nested under the hub: a hairline guide from the hub's square down. -->
        <ul
          v-if="folders.length > 0"
          class="m-0 mt-px ml-3 flex list-none flex-col gap-px border-l border-line p-0"
        >
          <li v-for="entry in folders" :key="entry.folder.id">
            <RouterLink
              :to="linkTo(entry)"
              :aria-current="currentOf(entry)"
              :class="[linkClass, entry.folder.id === folderId && 'bg-selected font-medium']"
              :style="{ paddingLeft: `${String(8 + entry.depth * 12)}px` }"
              data-folder-link
            >
              <span
                aria-hidden="true"
                class="size-2 shrink-0"
                :style="{ background: paletteVar(entry.folder.color) }"
              />
              <span class="min-w-0 flex-1 truncate">{{ entry.folder.name }}</span>
              <span
                v-if="entry.ownCount !== null"
                class="text-caption text-ink3 tabular-nums"
                :aria-label="countLabel(entry.ownCount)"
                data-folder-count
                >{{ format.format(entry.ownCount) }}</span
              >
            </RouterLink>
          </li>
        </ul>
      </li>
    </ul>
  </nav>
</template>
