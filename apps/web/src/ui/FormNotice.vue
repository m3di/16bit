<script setup lang="ts">
/**
 * A message about a whole form or action, not one field (fields show their own error).
 * error: something failed; announced at once (role=alert), in --danger with a filled square.
 * info: something to know, such as why an action is refused; announced politely (role=status),
 * in --ink2 with an outlined square. No box: the square and the colour set it apart.
 * The optional `action` slot holds a quiet button such as Dismiss, outside the live region.
 */
export type NoticeTone = 'error' | 'info'

const { tone = 'error' } = defineProps<{ tone?: NoticeTone }>()
defineSlots<{ default(): unknown; action?(): unknown }>()
</script>

<template>
  <div class="flex flex-wrap items-start gap-x-3 gap-y-1" :data-tone="tone" data-form-notice>
    <p
      :role="tone === 'error' ? 'alert' : 'status'"
      :class="[
        'm-0 flex min-w-0 flex-[1_1_240px] items-start gap-2 text-secondary',
        tone === 'error' ? 'text-danger' : 'text-ink2',
      ]"
    >
      <span
        aria-hidden="true"
        :class="[
          'mt-1.5 block size-1.5 shrink-0',
          tone === 'error' ? 'bg-danger' : 'border border-line3',
        ]"
      />
      <span class="min-w-0"><slot /></span>
    </p>
    <div v-if="$slots.action" class="-my-1 shrink-0"><slot name="action" /></div>
  </div>
</template>
