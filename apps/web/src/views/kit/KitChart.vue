<script setup lang="ts">
import { ref } from 'vue'
import { BaseButton, BurndownChart, StateBlock } from '../../ui/index.ts'

// The burndown with the mockup's numbers: Sprint 24, Nov 9 to Nov 20 2026, 34 points, 18 left on
// Nov 16 (day 6 of 10 weekdays). The buttons move "today" to show the other cases.
const done: Record<string, number> = {
  '2026-11-09': 3,
  '2026-11-10': 2,
  '2026-11-11': 3,
  '2026-11-12': 5,
  '2026-11-14': 1,
  '2026-11-16': 2,
}
const todays = [
  { key: '2026-11-16', label: 'Nov 16' },
  { key: '2026-11-09', label: 'First day' },
  { key: '2026-11-14', label: 'Saturday' },
  { key: '2026-11-20', label: 'Last day' },
  { key: '2026-11-25', label: 'After' },
  { key: '2026-11-02', label: 'Before' },
]
const today = ref('2026-11-16')
</script>

<template>
  <section class="flex flex-col gap-3">
    <h3 class="m-0 border-b border-line pb-2 text-body font-medium">BurndownChart</h3>
    <div class="flex max-w-[480px] flex-col gap-2.5">
      <h4 class="m-0 text-body font-medium">Sprint 24 burndown</h4>
      <BurndownChart
        start="2026-11-09"
        end="2026-11-20"
        :total="34"
        :done-by-day="done"
        :today="today"
      />
    </div>
    <div class="flex flex-wrap items-center gap-2 text-caption text-ink3">
      <span>Today:</span>
      <BaseButton
        v-for="t in todays"
        :key="t.key"
        size="sm"
        :variant="today === t.key ? 'outline' : 'quiet'"
        @click="today = t.key"
        >{{ t.label }}</BaseButton
      >
    </div>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">Narrow, calendar days, a four-week sprint</span>
        <div class="max-w-[300px]">
          <BurndownChart
            start="2026-11-02"
            end="2026-11-29"
            days="calendar"
            :total="120"
            :done-by-day="{ '2026-11-05': 20, '2026-11-12': 30, '2026-11-19': 12 }"
            today="2026-11-23"
          />
        </div>
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">No points in the sprint: the block's empty state</span>
        <StateBlock state="empty" title="No points in this sprint" />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-caption text-ink3">Loading, from the block around the chart</span>
        <StateBlock state="loading" :rows="5" />
      </div>
    </div>
    <p class="m-0 text-caption text-ink3">
      Hand-written SVG, no chart library. Points left are the total minus points done by each item's
      "Done on" date (D82), over weekdays by default (D81). Each step is the start of a day; today's
      point is the points left now. Screen readers get a hidden table instead of the SVG.
    </p>
  </section>
</template>
