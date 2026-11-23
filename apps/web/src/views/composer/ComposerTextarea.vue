<script setup lang="ts">
import { computed, useId } from 'vue'

// A labelled multi-line input with BaseInput's look and contract (label, hint, error). There
// is no shared textarea yet; asked of design-system on the composer's issue. Replace this with
// it when it lands.

defineOptions({ inheritAttrs: false })

const model = defineModel<string>({ default: '' })
const {
  label,
  hint = '',
  error = '',
  mono,
  rows = 4,
} = defineProps<{
  label: string
  hint?: string
  error?: string
  mono?: boolean
  rows?: number
}>()

const id = useId()
const hintId = `${id}-hint`
const errorId = `${id}-error`
const describedBy = computed(
  () => [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined,
)
function onInput(event: Event) {
  if ((event as InputEvent).isComposing) return
  model.value = (event.target as HTMLTextAreaElement).value
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <label :for="id" class="text-secondary text-ink3">{{ label }}</label>
    <textarea
      v-bind="$attrs"
      :id="id"
      :value="model"
      :rows="rows"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="describedBy"
      :class="[
        'box-border w-full resize-y rounded-control border bg-bg px-2 py-1.5 text-ink placeholder:text-ink3',
        error ? 'border-danger' : 'border-line3',
        mono ? 'font-mono text-secondary' : 'text-body',
      ]"
      @input="onInput"
      @compositionend="onInput"
    />
    <span v-if="hint" :id="hintId" class="text-secondary text-ink3">{{ hint }}</span>
    <span v-if="error" :id="errorId" class="text-secondary text-danger">{{ error }}</span>
  </div>
</template>
