<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { StateBlock, paletteVar } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import type { FolderEntry } from './useHub.ts'

defineProps<{
  workspaceId: string
  hubName: string | null
  tree: Load<FolderEntry[]>
  /** The open folder. */
  folderId: string
}>()
</script>

<template>
  <nav aria-label="Folders" class="flex flex-col gap-1">
    <span class="truncate px-2 pb-1 text-caption text-ink3">{{ hubName ?? 'Hub' }}</span>
    <StateBlock v-if="tree.state === 'loading'" state="loading" title="Loading folders" />
    <p v-else-if="tree.state === 'error'" class="m-0 px-2 text-secondary text-ink3">
      Folders are not available.
    </p>
    <ul v-else class="m-0 flex list-none flex-col gap-px p-0">
      <li v-for="{ folder, depth } in tree.data" :key="folder.id">
        <RouterLink
          :to="{
            name: 'hub',
            params: {
              workspaceId,
              hubId: folder.hubId,
              folderId: folder.id === folder.hubId ? undefined : folder.id,
            },
          }"
          :aria-current="folder.id === folderId ? 'page' : undefined"
          class="flex min-h-8 items-center gap-2 rounded-control pr-2 text-ink no-underline hover:bg-selected"
          :class="folder.id === folderId && 'bg-selected font-medium'"
          :style="{ paddingLeft: `${String(8 + depth * 12)}px` }"
          data-folder-link
        >
          <span
            aria-hidden="true"
            class="size-2 shrink-0"
            :style="{ background: paletteVar(folder.color) }"
          />
          <span class="min-w-0 flex-1 truncate">{{ folder.name }}</span>
          <span
            v-if="folder.id !== folder.hubId"
            class="text-caption text-ink3 tabular-nums"
            :aria-label="`${String(folder.itemCount)} items`"
            >{{ folder.itemCount }}</span
          >
        </RouterLink>
      </li>
    </ul>
  </nav>
</template>
