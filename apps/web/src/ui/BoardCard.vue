<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { MAX_ROW_FIELDS, type FieldValue } from './blocks.ts'
import FieldText from './FieldText.vue'

// A card on a board (Work.dc.html): the title, then up to 4 fields on one quiet line,
// comma separated ("PT-214, 5 points"). A hairline card with radius 6 and no shadow; the whole
// card is the link or button that opens the item.
const {
  title,
  fields = [],
  to = null,
} = defineProps<{
  title: string
  fields?: FieldValue[]
  /** Opens the item by route. Without it the card is a button that emits `open`. */
  to?: RouteLocationRaw | null
}>()

const emit = defineEmits<{ open: [] }>()

const shown = computed(() => fields.filter((f) => f.text !== '').slice(0, MAX_ROW_FIELDS))
function onClick() {
  if (!to) emit('open')
}
</script>

<template>
  <component
    :is="to ? RouterLink : 'button'"
    :to="to"
    :type="to ? undefined : 'button'"
    class="flex w-full cursor-pointer flex-col gap-1.5 rounded-card border border-line bg-bg p-3 text-left text-ink hover:border-line2"
    data-block="board-card"
    @click="onClick"
  >
    <span>{{ title }}</span>
    <span v-if="shown.length" class="text-secondary text-ink3">
      <template v-for="(field, i) in shown" :key="i"
        ><template v-if="i > 0">, </template
        ><FieldText :value="field" tone="ink3" class="align-bottom"
      /></template>
    </span>
  </component>
</template>
