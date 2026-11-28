<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'
import { inertOutside, useSheet } from './sheet.ts'

const {
  title,
  label = 'Item',
  keepFocus,
} = defineProps<{
  /** The item's display ID or name. */
  title: string
  /** Names the panel for screen readers. */
  label?: string
  /**
   * Leaves focus where it is when the panel opens or shows another item, as when the arrow
   * keys move the selection in the table beside it. By default focus moves to the panel. A
   * sheet (below `lg`) covers the table, so it always takes focus.
   */
  keepFocus?: boolean
}>()

const emit = defineEmits<{ close: [] }>()

const panel = useTemplateRef<HTMLElement>('panel')
const heading = useTemplateRef<HTMLHeadingElement>('heading')
// Registered first, so it has read the viewport before the panel's own mounted hook runs.
const sheet = useSheet()

// As a sheet the panel is modal: what it covers is inert, and focus goes back to where it was
// (the row that opened it) when it closes.
let restoreInert: (() => void) | null = null
let returnTo: HTMLElement | null = null
function setModal(on: boolean) {
  restoreInert?.()
  restoreInert = null
  const el = panel.value
  if (on && el) restoreInert = inertOutside(el, document.body)
}

// Move focus to the panel when it opens or shows another item, so keyboard and phone users
// land on it.
const focus = () => {
  if (!keepFocus || sheet.value) heading.value?.focus()
}
onMounted(() => {
  if (sheet.value) {
    const active = document.activeElement
    returnTo = active instanceof HTMLElement ? active : null
    setModal(true)
  }
  focus()
})
watch(() => title, focus, { flush: 'post' })
watch(sheet, (on) => {
  setModal(on)
  if (on) focus()
})
onBeforeUnmount(() => {
  const wasSheet = restoreInert !== null
  setModal(false)
  if (wasSheet && returnTo?.isConnected) returnTo.focus()
})

// From `lg` up the panel is a pane beside the content (D85): as tall as the content pane, adding
// nothing to its height (size containment), with its content scrolling on its own, so a long
// item never moves the table. Below `lg` it is a full-screen sheet over the page with its own
// scroll. The title row stays at the top of the scroll, so Close is always in reach. (A comment
// here, not in the template: one there would make the template a fragment, and the class a
// screen passes would not reach the aside.)
</script>

<template>
  <aside
    ref="panel"
    :aria-label="label"
    class="box-border flex min-w-0 flex-col bg-bg max-lg:fixed max-lg:inset-0 max-lg:z-20 lg:border-l lg:border-line lg:[contain:size]"
    :data-sheet="sheet ? '' : undefined"
    data-item-panel
    @keydown.esc="emit('close')"
  >
    <div
      class="box-border flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-y-contain px-4 pb-5 sm:px-5"
      data-item-panel-scroll
    >
      <div class="sticky top-0 z-[1] flex items-start justify-between gap-3 bg-bg pt-5 pb-1">
        <h2
          ref="heading"
          tabindex="-1"
          class="m-0 min-w-0 font-display text-card-title font-medium break-words outline-none"
        >
          {{ title }}
        </h2>
        <button
          type="button"
          aria-label="Close panel"
          class="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control border border-transparent bg-transparent text-ink2 hover:bg-selected"
          @click="emit('close')"
        >
          <svg aria-hidden="true" focusable="false" viewBox="0 0 10 10" class="size-2.5">
            <path d="M1 1l8 8M9 1l-8 8" fill="none" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
      </div>
      <slot />
    </div>
  </aside>
</template>
