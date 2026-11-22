<script setup lang="ts">
import { onMounted, useTemplateRef, watch } from 'vue'

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
   * keys move the selection in the table beside it. By default focus moves to the panel.
   */
  keepFocus?: boolean
}>()

const emit = defineEmits<{ close: [] }>()

const heading = useTemplateRef<HTMLHeadingElement>('heading')

// Move focus to the panel when it opens or shows another item, so keyboard and phone users
// land on it. At phone width it sits under the table, and focusing scrolls it into view.
const focus = () => {
  if (!keepFocus) heading.value?.focus()
}
onMounted(focus)
watch(() => title, focus, { flush: 'post' })

// At desktop width the panel sits beside the table and adds nothing to the row's height (size
// containment), so the row is as tall as the column beside it, which fills the viewport. Its
// content scrolls on its own in a sticky box no taller than the viewport or the row, so a long
// item never scrolls the page and the table stays in view. At phone width it stacks under the
// table and the page scrolls as before. (A comment here, not in the template: one there would
// make the template a fragment, and the class a screen passes would not reach the aside.)
</script>

<template>
  <aside
    :aria-label="label"
    class="box-border flex min-w-0 flex-col border-t border-line lg:border-t-0 lg:border-l lg:[contain:size]"
    data-item-panel
    @keydown.esc="emit('close')"
  >
    <div
      class="box-border flex min-h-0 flex-col gap-5 px-4 py-5 sm:px-5 lg:sticky lg:top-0 lg:max-h-[min(100dvh,100%)] lg:overflow-y-auto"
      data-item-panel-scroll
    >
      <div class="flex items-start justify-between gap-3">
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
