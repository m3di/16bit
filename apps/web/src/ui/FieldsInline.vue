<script setup lang="ts">
import type { DataBlockState, InlineField } from './blocks.ts'
import BlockStatus from './BlockStatus.vue'
import FieldText from './FieldText.vue'

// The `fields` block: one item's attributes (D77). Inline is a line of label and value pairs
// under a page title ("Sprint Sprint 24  Start Nov 9  End Nov 20"), replacing the mockup's
// generated sentence (D82). Stacked is a label column and a value column, as on the item page.
// The `value` slot takes a rich value (an actor chip, palette chips) in place of the text.
const {
  fields,
  stacked,
  state = 'ready',
  stateTitle = '',
  stateMessage = null,
} = defineProps<{
  fields: InlineField[]
  stacked?: boolean
  state?: DataBlockState
  stateTitle?: string
  stateMessage?: string | null
}>()

defineSlots<{ value?: (props: { field: InlineField }) => unknown }>()
</script>

<template>
  <BlockStatus
    v-if="state !== 'ready'"
    :state="state"
    :title="stateTitle"
    :message="stateMessage"
    :rows="stacked ? 3 : 1"
  />
  <dl
    v-else
    :class="[
      'm-0',
      stacked
        ? 'grid grid-cols-[minmax(80px,110px)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2'
        : 'flex flex-wrap gap-x-5 gap-y-1',
    ]"
    data-block="fields"
    :data-layout="stacked ? 'stacked' : 'inline'"
  >
    <template v-if="stacked">
      <template v-for="field in fields" :key="field.key">
        <dt class="text-ink3">{{ field.label }}</dt>
        <dd class="m-0 min-w-0">
          <slot name="value" :field="field"><FieldText :value="field.value" tone="ink" /></slot>
        </dd>
      </template>
    </template>
    <div
      v-for="field in fields"
      v-else
      :key="field.key"
      class="flex min-w-0 items-baseline gap-1.5"
    >
      <dt class="text-ink3">{{ field.label }}</dt>
      <dd class="m-0 min-w-0">
        <slot name="value" :field="field"><FieldText :value="field.value" /></slot>
      </dd>
    </div>
  </dl>
</template>
