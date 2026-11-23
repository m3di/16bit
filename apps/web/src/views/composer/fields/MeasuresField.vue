<script setup lang="ts">
import { computed } from 'vue'
import { BaseButton } from '../../../ui/index.ts'
import { useField } from '../form-context.ts'
import MeasureField from './MeasureField.vue'

// A short list of measures: up to 2 per list group or bar row (D77). With two on a bar chart
// the second is the "of" ("11 of 12").
const {
  path,
  folderId,
  min = 0,
  max,
  names,
} = defineProps<{
  path: string
  folderId: string
  min?: number
  max: number
  /** A label per position, "Value" and "Of". */
  names: readonly string[]
}>()

const { value, error } = useField<unknown[] | undefined>(() => path, { exact: true })
const list = computed(() => (Array.isArray(value.value) ? value.value : []))
function add() {
  value.value = [...list.value, { fn: 'count' }]
}
function remove(i: number) {
  value.value = list.value.filter((_, j) => j !== i)
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div
      v-for="(_, i) in list"
      :key="`${String(i)}/${String(list.length)}`"
      class="flex flex-col gap-1"
    >
      <MeasureField
        :path="`${path}.${String(i)}`"
        :folder-id="folderId"
        :label="names[i] ?? `Measure ${String(i + 1)}`"
      />
      <div v-if="list.length > min">
        <BaseButton size="sm" variant="quiet" class="-ml-3" @click="remove(i)"
          >Remove {{ (names[i] ?? `measure ${String(i + 1)}`).toLowerCase() }}</BaseButton
        >
      </div>
    </div>
    <div v-if="list.length < max">
      <BaseButton size="sm" @click="add"
        >Add {{ (names[list.length] ?? 'measure').toLowerCase() }}</BaseButton
      >
    </div>
    <span v-if="error" class="text-secondary text-danger">{{ error }}</span>
  </div>
</template>
