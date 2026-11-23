<script setup lang="ts">
import type { Block } from '@16bit/core'
import { computed } from 'vue'
import { NumberStat } from '../../../ui/index.ts'
import { attributeOf, formatNumber } from '../format.ts'
import { formatValue } from '../../hub/values.ts'
import type { BlockLoad } from '../useRootView.ts'
import { useBlock } from './use-block.ts'

// The `number` block (D77): one measure over a set, optionally "of" a second ("16 of 34"), or
// the bound item's day between two of its dates ("day 6 of 10", D81).
const { block, load = null } = defineProps<{
  block: Block
  load?: BlockLoad | null
  level: number
}>()

const config = computed(() => (block.type === 'number' ? block.config : null))
const aggregate = useBlock(() => load, 'aggregate')
const days = useBlock(() => load, 'days')
const isDays = computed(() => config.value?.kind === 'days')

const label = computed(() => {
  const c = config.value
  if (!c) return ''
  if (c.label) return c.label
  if (c.kind === 'days') return 'Day'
  const a = c.value.attribute ? attributeOf(aggregate.description(), c.value.attribute) : null
  return a?.name ?? 'Items'
})

/** A measure's value as the number shows it. Dates (`earliest`, `latest`) as dates. */
function text(value: number | string | null | undefined, attribute?: string): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return formatNumber(value)
  const a = attribute ? attributeOf(aggregate.description(), attribute) : undefined
  return a ? formatValue(a, value) || value : value
}

const shown = computed(() => {
  const c = config.value
  if (!c) return { state: 'error' as const, value: '', of: '', stateText: '' }
  if (c.kind === 'days') {
    const d = days.data.value
    if (days.state.value !== 'ready' || !d)
      return { state: days.state.value, value: '', of: '', stateText: '' }
    if (d.of === null) return { state: 'empty' as const, value: '', of: '', stateText: 'No dates' }
    if (d.day === null) {
      return { state: 'empty' as const, value: '', of: '', stateText: 'Outside its dates' }
    }
    return {
      state: 'ready' as const,
      value: formatNumber(d.day),
      of: formatNumber(d.of),
      stateText: '',
    }
  }
  const d = aggregate.data.value
  if (aggregate.state.value !== 'ready' || !d) {
    return { state: aggregate.state.value, value: '', of: '', stateText: '' }
  }
  const values = d.groups[0]?.values ?? []
  const value = text(values[0], c.value.attribute)
  if (value === '') return { state: 'empty' as const, value: '', of: '', stateText: '' }
  const total = c.total ? text(values[1], c.total.attribute) : ''
  return { state: 'ready' as const, value, of: total, stateText: '' }
})
</script>

<template>
  <div
    :data-view-block="block.id"
    data-block="number"
    :data-block-state="shown.state"
    :data-days="isDays || undefined"
  >
    <NumberStat
      :label="label"
      :value="shown.value"
      :of="shown.of"
      :state="shown.state"
      :state-text="shown.stateText"
    />
  </div>
</template>
