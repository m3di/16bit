<script setup lang="ts">
import type { PaletteColor } from '@16bit/core'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { RowActionsMenu, paletteVar } from '../../ui/index.ts'
import type { FolderAction, FolderActionKey } from '../hub-settings/schema.ts'

// One folder in the hub page's sidebar: a link with the folder's square, name and count, and its
// actions menu beside the link (never inside it, so opening the menu does not navigate).

const props = defineProps<{
  to: RouteLocationRaw
  label: string
  color: PaletteColor
  count: number | null
  /** `aria-current` for the open folder. */
  current?: 'page' | 'location'
  /** Left padding of the link, in px. */
  indent: number
  /** The folder's actions, or none for no menu. */
  actions: readonly FolderAction[]
  /** Names the menu button: "Actions for Bugs". */
  actionsLabel: string
  /** The hub's root folder: shown as the hub's name, read out as the hub's own items. */
  root?: boolean
}>()

const emit = defineEmits<{ action: [key: FolderActionKey] }>()

const format = new Intl.NumberFormat('en')
const countLabel = (n: number) => (n === 1 ? '1 item' : `${format.format(n)} items`)
const rootLabel = () =>
  [
    props.label,
    'items in the hub itself',
    ...(props.count === null ? [] : [countLabel(props.count)]),
  ].join(', ')
</script>

<template>
  <div
    class="group flex min-h-8 items-center rounded-control hover:bg-selected"
    :class="current && 'bg-selected'"
  >
    <RouterLink
      :to="to"
      :aria-current="current"
      class="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-control pr-2 text-ink no-underline"
      :class="current && 'font-medium'"
      :style="{ paddingLeft: `${String(indent)}px` }"
      :aria-label="root ? rootLabel() : undefined"
      data-folder-link
      :data-folder-root="root || undefined"
    >
      <span aria-hidden="true" class="size-2 shrink-0" :style="{ background: paletteVar(color) }" />
      <span class="min-w-0 flex-1 truncate">{{ label }}</span>
      <span
        v-if="count !== null"
        class="text-caption text-ink3 tabular-nums"
        :aria-label="countLabel(count)"
        data-folder-count
        >{{ format.format(count) }}</span
      >
    </RouterLink>
    <!-- On hover or keyboard focus of the row; always on touch screens and at phone width. -->
    <span
      v-if="actions.length > 0"
      class="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100 pointer-coarse:opacity-100"
      data-folder-actions
    >
      <RowActionsMenu
        :label="actionsLabel"
        :items="actions"
        @select="emit('action', $event as FolderActionKey)"
      />
    </span>
  </div>
</template>
