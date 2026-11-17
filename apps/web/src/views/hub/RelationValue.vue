<script setup lang="ts">
import type { Item } from '@16bit/core'
import { computed, watchEffect } from 'vue'
import { RelationChip, ValueState } from '../../ui/index.ts'
import { useValueContext } from './context.ts'
import { chipView } from './relations.ts'

const {
  ids,
  label,
  limit = Infinity,
  removable,
  inline,
  resolve,
} = defineProps<{
  /** Linked item IDs, in value order. */
  ids: readonly string[]
  /** Accessible name of the list, usually the attribute name. */
  label: string
  /** Show at most this many chips and a count for the rest, as in table cells. */
  limit?: number
  /** Each chip gets a remove button. Emits `remove` with the item ID. */
  removable?: boolean
  /** One line, for table rows. */
  inline?: boolean
  /** Read linked items the folder query did not cover. Off in table cells. */
  resolve?: boolean
}>()

defineEmits<{ remove: [id: string] }>()

const ctx = useValueContext()

const views = computed(() =>
  ids.flatMap((id) => {
    const state = ctx.linkState(id)
    const view = chipView(id, state, ctx.hubLookup)
    return view ? [{ id, view, unknown: state.access === 'unknown' }] : []
  }),
)

// In the panel, read what the list did not bring. Hubs of readable linked items are read once.
watchEffect(() => {
  if (resolve) ctx.resolveLinked(ids)
  const hubs = new Set<string>()
  for (const id of ids) {
    const state = ctx.linkState(id)
    if (state.access === 'read') hubs.add(state.item.hubId)
  }
  ctx.ensureHubs(hubs)
})

const shown = computed(() => views.value.slice(0, Math.max(0, limit)))
const overflow = computed(() => views.value.length - shown.value.length)

const linkTo = (item: Item | null) => (item ? ctx.itemLink(item) : null)
</script>

<template>
  <ValueState v-if="views.length === 0" state="empty" />
  <ul
    v-else
    :aria-label="label"
    :class="[
      'm-0 flex min-w-0 list-none items-center gap-x-3 gap-y-1 p-0',
      inline ? 'flex-nowrap whitespace-nowrap' : 'flex-wrap',
    ]"
  >
    <li
      v-for="{ id, view, unknown } in shown"
      :key="id"
      class="inline-flex min-w-0 max-w-full items-center gap-1"
      :data-linked="id"
    >
      <template v-if="view.state === 'ready'">
        <RelationChip :target="view.target" :to="linkTo(view.item)" />
      </template>
      <!-- In a cell, an ID the query did not expand is said to be not loaded, not guessed at. -->
      <ValueState v-else-if="unknown && !resolve" state="empty" label="Not loaded" />
      <RelationChip v-else :target="null" :state="view.state" />
      <button
        v-if="removable"
        type="button"
        :aria-label="
          view.state === 'ready' && view.target.access === 'ok'
            ? `Remove ${view.target.title}`
            : 'Remove this linked item'
        "
        class="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-ink3 hover:bg-selected hover:text-ink"
        data-remove-link
        @click="$emit('remove', id)"
      >
        <svg aria-hidden="true" focusable="false" viewBox="0 0 8 8" class="size-2">
          <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
    </li>
    <li v-if="overflow > 0" class="inline-flex text-caption text-ink3">
      +{{ overflow }}<span class="sr-only"> more linked items</span>
    </li>
  </ul>
</template>
