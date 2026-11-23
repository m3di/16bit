<script setup lang="ts">
import type { Block } from '@16bit/core'
import { computed } from 'vue'
import { BarRows, BlockStatus, BurndownChart, type BarRow } from '../../../ui/index.ts'
import { useOptionalValueContext } from '../../hub/context.ts'
import { attributeOf, doneByDay, formatNumber, groupLabel } from '../format.ts'
import type { BlockLoad } from '../useRootView.ts'
import { useBlock } from './use-block.ts'

// The `chart` block (D77, D82): `bars`, one bar row per group with 1 or 2 measures ("11 of 12"),
// a row per person when grouped by an actor; or `burndown` over the bound sprint's dates.
const { block, load = null } = defineProps<{
  block: Block
  load?: BlockLoad | null
  level: number
}>()

const config = computed(() => (block.type === 'chart' ? block.config : null))
const bars = useBlock(() => load, 'aggregate')
const burn = useBlock(() => load, 'burndown')
const values = useOptionalValueContext()

const groupAttribute = computed(() => {
  const c = config.value
  return c?.kind === 'bars' ? attributeOf(bars.description(), c.groupBy.attribute) : undefined
})
const layout = computed(() => (groupAttribute.value?.type === 'actor' ? 'inline' : 'stacked'))

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const rows = computed((): BarRow[] => {
  const c = config.value
  const d = bars.data.value
  if (c?.kind !== 'bars' || !d) return []
  const of = c.measures.length > 1
  const most = Math.max(0, ...d.groups.map((g) => num(g.values[0])))
  return d.groups.map((g, i) => {
    const value = num(g.values[0])
    const max = of ? num(g.values[1]) : most
    const actorId = layout.value === 'inline' && g.key.kind === 'value' ? String(g.key.value) : null
    const actor = actorId && values ? values.actor(actorId) : null
    return {
      id: g.key.kind === 'value' ? `v:${String(g.key.value)}` : `${g.key.kind}:${String(i)}`,
      label: groupLabel(g.key, groupAttribute.value, bars.names),
      ...(actor
        ? {
            actor: actor.known
              ? { id: actor.id, name: actor.name, kind: actor.kind }
              : { id: actor.id, kind: 'unknown' as const },
          }
        : {}),
      value,
      max,
      text: of ? `${formatNumber(value)} of ${formatNumber(max)}` : formatNumber(value),
    }
  })
})

const label = computed(() => config.value?.label ?? '')
const burndown = computed(() => {
  const d = burn.data.value
  return d ? { ...d, done: doneByDay(d.total, d.days) } : null
})
const burnDays = computed(() =>
  config.value?.kind === 'burndown' ? config.value.days : 'weekdays',
)
</script>

<template>
  <div :data-view-block="block.id" data-block="chart" :data-chart="config?.kind">
    <BarRows
      v-if="config?.kind === 'bars'"
      :rows="rows"
      :layout="layout"
      :state="bars.state.value"
      :label="label"
    />
    <template v-else>
      <BlockStatus v-if="burn.state.value !== 'ready'" :state="burn.state.value" :rows="4" />
      <BlockStatus
        v-else-if="!burndown || burndown.total === 0"
        state="empty"
        title="Nothing to burn down"
        message="The items in this sprint have no points."
      />
      <BurndownChart
        v-else
        :start="burndown.start"
        :end="burndown.end"
        :total="burndown.total"
        :done-by-day="burndown.done"
        :today="burndown.today"
        :days="burnDays"
        v-bind="label ? { label } : {}"
      />
    </template>
  </div>
</template>
