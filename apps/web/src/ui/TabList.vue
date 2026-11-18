<script setup lang="ts" generic="Key extends string">
import { nextTick, useId, useTemplateRef } from 'vue'
import { rovingIndex } from './roving.ts'

export interface Tab<K extends string = string> {
  key: K
  label: string
}

const model = defineModel<Key>({ required: true })

const { label, tabs } = defineProps<{
  /** Names the tab list for screen readers, such as "Attribute settings". */
  label: string
  tabs: readonly { key: Key; label: string }[]
}>()

defineSlots<{ default(props: { tab: Key }): unknown }>()

const id = useId()
const tabId = (key: string) => `${id}-tab-${key}`
const panelId = (key: string) => `${id}-panel-${key}`
const buttons = useTemplateRef<HTMLButtonElement[]>('buttons')

// WAI-ARIA tabs with automatic activation: the list is one tab stop, arrow keys move and select
// (wrapping), Home and End jump to the ends. Tab then moves into the panel.
async function onKeydown(event: KeyboardEvent, index: number) {
  const next = rovingIndex(index, event.key, tabs.length)
  if (next === null) return
  event.preventDefault()
  const tab = tabs[next]
  if (!tab) return
  model.value = tab.key
  await nextTick()
  buttons.value?.[next]?.focus()
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div role="tablist" :aria-label="label" class="flex flex-wrap gap-1 border-b border-line pb-1">
      <button
        v-for="(tab, i) in tabs"
        :id="tabId(tab.key)"
        ref="buttons"
        :key="tab.key"
        type="button"
        role="tab"
        :aria-selected="model === tab.key ? 'true' : 'false'"
        :aria-controls="model === tab.key ? panelId(tab.key) : undefined"
        :tabindex="model === tab.key ? 0 : -1"
        :class="[
          'inline-flex min-h-8 cursor-pointer items-center rounded-control border-0 px-2.5',
          model === tab.key
            ? 'bg-selected font-medium text-ink'
            : 'bg-transparent text-ink2 hover:text-ink',
        ]"
        @click="model = tab.key"
        @keydown="onKeydown($event, i)"
      >
        {{ tab.label }}
      </button>
    </div>
    <!-- Only the selected panel is rendered. It is focusable so Tab reaches it even when it holds
         no control. -->
    <div
      v-for="tab in tabs.filter((t) => t.key === model)"
      :id="panelId(tab.key)"
      :key="tab.key"
      role="tabpanel"
      :aria-labelledby="tabId(tab.key)"
      tabindex="0"
      class="min-w-0 rounded-control"
    >
      <slot :tab="tab.key" />
    </div>
  </div>
</template>
