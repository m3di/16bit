<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import {
  PLOT,
  burndown,
  burndownGeometry,
  formatDay,
  formatPoints,
  type DayMode,
} from './burndown.ts'

// The `chart` block's burndown (Main.dc.html), hand-written SVG with no chart library. Colours are
// token utilities on SVG fill and stroke, so the chart follows the theme without a rebuild (D39).
// The SVG is hidden from screen readers; a visually hidden table gives the same numbers.
// The block's loading, error and other states are BlockStatus around it, as for any block.
const {
  start,
  end,
  total,
  doneByDay,
  today,
  days = 'weekdays',
  label = 'Points left by day',
} = defineProps<{
  /** The bound sprint's first and last day, date-only ISO strings in the reader's zone. */
  start: string
  end: string
  total: number
  /** Points done per "Done on" date (D82). */
  doneByDay: Record<string, number>
  today: string
  days?: DayMode
  /** The data table's caption, read by screen readers. */
  label?: string
}>()

const box = useTemplateRef<HTMLElement>('box')
// The SVG is as many units wide as its box is pixels, so text stays 11px at any width.
const width = ref(480)
let observer: ResizeObserver | null = null
onMounted(() => {
  const el = box.value
  if (!el || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(([entry]) => {
    const w = Math.round(entry?.contentRect.width ?? 0)
    if (w > 0 && w !== width.value) width.value = w
  })
  observer.observe(el)
})
onBeforeUnmount(() => observer?.disconnect())

const series = computed(() => burndown({ start, end, total, doneByDay, today, days }))
const geo = computed(() => burndownGeometry(series.value, width.value))

const rows = computed(() => {
  const b = series.value
  return b.days.map((day, i) => ({
    day: formatDay(day) + (i === b.todayIndex ? ', today' : ''),
    left: i < b.actual.length ? formatPoints(b.actual[i] ?? 0) : 'Not yet',
    ideal: formatPoints(b.ideal[i] ?? 0),
  }))
})
const endRow = computed(() => {
  const b = series.value
  const n = b.days.length
  return b.actual.length > n ? formatPoints(b.actual[n] ?? 0) : null
})
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2" data-block="chart" data-chart="burndown">
    <div aria-hidden="true" class="flex justify-end gap-3.5 text-caption text-ink3">
      <span class="inline-flex items-center gap-1.5"
        ><span class="block h-0.5 w-3 bg-accent" />Actual</span
      >
      <span class="inline-flex items-center gap-1.5"
        ><span class="block w-3 border-t-2 border-dashed border-ink3" />Ideal</span
      >
    </div>
    <div ref="box" class="min-w-0">
      <svg
        aria-hidden="true"
        focusable="false"
        :viewBox="`0 0 ${geo.width} ${PLOT.height}`"
        :width="geo.width"
        :height="PLOT.height"
        class="block h-auto max-w-full font-sans text-caption"
      >
        <path
          :d="geo.grid.map((y) => `M${PLOT.left} ${y}H${geo.width - PLOT.rightPad}`).join('')"
          class="fill-none stroke-line"
          stroke-width="1"
        />
        <g class="fill-ink3">
          <text
            v-for="l in geo.yLabels"
            :key="`y${l.text}`"
            :x="l.x"
            :y="l.y"
            :text-anchor="l.anchor"
          >
            {{ l.text }}
          </text>
          <text
            v-for="l in geo.xLabels"
            :key="`x${l.text}`"
            :x="l.x"
            :y="l.y"
            :text-anchor="l.anchor"
          >
            {{ l.text }}
          </text>
        </g>
        <path
          v-if="geo.idealPath"
          :d="geo.idealPath"
          class="fill-none stroke-ink3"
          stroke-width="1"
          stroke-dasharray="4 4"
        />
        <path
          v-if="geo.actualPath"
          :d="geo.actualPath"
          class="fill-none stroke-accent"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
        <g class="fill-bg stroke-accent" stroke-width="1.5">
          <circle v-for="(d, i) in geo.dots" :key="i" :cx="d.x" :cy="d.y" r="2.5" />
        </g>
        <template v-if="geo.today">
          <circle :cx="geo.today.x" :cy="geo.today.y" r="4" class="fill-accent" />
          <rect
            :x="geo.today.box.x"
            :y="geo.today.box.y"
            :width="geo.today.box.w"
            height="22"
            rx="4"
            class="fill-ink"
          />
          <text
            :x="geo.today.box.x + geo.today.box.w / 2"
            :y="geo.today.box.y + 15"
            text-anchor="middle"
            class="fill-bg"
          >
            {{ geo.today.text }}
          </text>
        </template>
      </svg>
    </div>
    <table class="sr-only">
      <caption>
        {{
          label
        }}
      </caption>
      <thead>
        <tr>
          <th scope="col">Day</th>
          <th scope="col">Points left</th>
          <th scope="col">Ideal</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.day">
          <th scope="row">{{ row.day }}</th>
          <td>{{ row.left }}</td>
          <td>{{ row.ideal }}</td>
        </tr>
        <tr v-if="endRow !== null">
          <th scope="row">End of sprint</th>
          <td>{{ endRow }}</td>
          <td>0</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
