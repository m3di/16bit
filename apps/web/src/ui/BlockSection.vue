<script setup lang="ts">
import { useId } from 'vue'

// The `section` block: an h2 with a caption on the right ("Sprint 24, by stage"), an optional
// actions slot ("New item"), then its child blocks. It holds no data, so it has no states of its
// own: each child block shows its own (D18), and one broken child never hides the others.
const { title = '', caption = '' } = defineProps<{
  /** Without a title the section is only a group, named by nothing. */
  title?: string
  caption?: string
}>()

const headingId = useId()
</script>

<template>
  <section
    :aria-labelledby="title ? headingId : undefined"
    class="flex min-w-0 flex-col gap-1.5"
    data-block="section"
  >
    <div
      v-if="title || caption || $slots.actions"
      class="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1"
    >
      <h2 v-if="title" :id="headingId" class="m-0 text-body font-medium text-ink">{{ title }}</h2>
      <span class="ml-auto flex flex-wrap items-center gap-3">
        <span v-if="caption" class="text-caption text-ink3">{{ caption }}</span>
        <slot name="actions" />
      </span>
    </div>
    <slot />
  </section>
</template>
