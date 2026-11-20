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
</script>

<template>
  <aside
    :aria-label="label"
    class="box-border flex min-w-0 flex-col gap-5 border-t border-line px-4 py-5 sm:px-5 lg:border-t-0 lg:border-l"
    data-item-panel
    @keydown.esc="emit('close')"
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
  </aside>
</template>
