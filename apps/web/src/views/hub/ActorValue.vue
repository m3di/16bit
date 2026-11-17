<script setup lang="ts">
import { computed } from 'vue'
import { ActorChip, ValueState } from '../../ui/index.ts'
import { useValueContext } from './context.ts'

const {
  ids,
  label,
  limit = Infinity,
  removable,
  inline,
} = defineProps<{
  /** Principal IDs, in value order. */
  ids: readonly string[]
  /** Accessible name of the list, usually the attribute name. */
  label: string
  /** Show at most this many and a count for the rest, as in table cells. */
  limit?: number
  /** Each actor gets a remove button. Emits `remove` with the principal ID. */
  removable?: boolean
  /** One line, for table rows. */
  inline?: boolean
}>()

defineEmits<{ remove: [id: string] }>()

const ctx = useValueContext()
const actors = computed(() => [...new Set(ids)].map((id) => ctx.actor(id)))
const shown = computed(() => actors.value.slice(0, Math.max(0, limit)))
const overflow = computed(() => actors.value.length - shown.value.length)
</script>

<template>
  <ValueState v-if="actors.length === 0" state="empty" />
  <ul
    v-else
    :aria-label="label"
    :class="[
      'm-0 flex min-w-0 list-none items-center gap-x-3 gap-y-1 p-0',
      inline ? 'flex-nowrap whitespace-nowrap' : 'flex-wrap',
    ]"
  >
    <li
      v-for="actor in shown"
      :key="actor.id"
      class="inline-flex min-w-0 max-w-full items-center gap-1"
      :data-actor="actor.id"
      :data-known="actor.known ? 'true' : 'false'"
    >
      <!-- An actor that cannot be named shows its avatar and a short ID, never a made-up name. -->
      <ActorChip :actor="actor" />
      <span v-if="!actor.known" class="sr-only">: not in the member list</span>
      <button
        v-if="removable"
        type="button"
        :aria-label="`Remove ${actor.name}`"
        class="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-ink3 hover:bg-selected hover:text-ink"
        data-remove-actor
        @click="$emit('remove', actor.id)"
      >
        <svg aria-hidden="true" focusable="false" viewBox="0 0 8 8" class="size-2">
          <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
    </li>
    <li v-if="overflow > 0" class="inline-flex text-caption text-ink3">
      +{{ overflow }}<span class="sr-only"> more</span>
    </li>
  </ul>
</template>
