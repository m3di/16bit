<script setup lang="ts">
import { useId } from 'vue'
import { countLabel, moreText, type BoardCardData } from './blocks.ts'
import BoardCard from './BoardCard.vue'
import { paletteVar, type PaletteColor } from './palette.ts'

// One column of a board (Work.dc.html): the option's dot, its name and the count over a
// hairline, then its cards. An empty column is always shown (D77), with its empty text in a
// dashed box ("Nothing of yours is in review.").
const {
  label,
  color = null,
  count,
  cards,
  emptyText = 'Nothing here.',
  creatable,
} = defineProps<{
  label: string
  color?: PaletteColor | null
  /** All cards in the column, which can be more than the cards shown. */
  count: number
  cards: BoardCardData[]
  emptyText?: string
  /** "New item" at the foot of the column, which presets the column's value (D77). */
  creatable?: boolean
}>()

const emit = defineEmits<{ open: [cardId: string]; create: [] }>()

const headingId = useId()
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2" data-block="board-column">
    <h3
      :id="headingId"
      class="m-0 flex items-center gap-1.5 border-b border-line pb-2 text-body font-normal text-ink"
    >
      <span
        aria-hidden="true"
        :class="['size-1.5 shrink-0 rounded-full', !color && 'bg-line3']"
        :style="color ? { background: paletteVar(color) } : undefined"
      />
      <span class="min-w-0 truncate">{{ label }}</span>
      <span class="text-ink3" aria-hidden="true">{{ count.toLocaleString('en-US') }}</span>
      <span class="sr-only">, {{ countLabel(count) }}</span>
    </h3>
    <ul
      v-if="cards.length > 0"
      :aria-labelledby="headingId"
      class="m-0 flex list-none flex-col gap-2 p-0"
    >
      <li v-for="card in cards" :key="card.id">
        <BoardCard
          :title="card.title"
          :fields="card.fields"
          :to="card.to"
          @open="emit('open', card.id)"
        />
      </li>
    </ul>
    <p
      v-else
      class="m-0 rounded-card border border-dashed border-line2 p-3 text-ink3"
      data-column-empty
    >
      {{ emptyText }}
    </p>
    <p v-if="count > cards.length && cards.length > 0" class="m-0 text-secondary text-ink3">
      {{ moreText(count - cards.length) }}
    </p>
    <button
      v-if="creatable"
      type="button"
      class="inline-flex min-h-7 cursor-pointer items-center self-start rounded-control px-2 text-ink3 hover:bg-selected hover:text-ink"
      @click="emit('create')"
    >
      New item<span class="sr-only"> in {{ label }}</span>
    </button>
  </div>
</template>
