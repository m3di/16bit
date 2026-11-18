<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import BaseButton from './BaseButton.vue'
import BaseDialog from './BaseDialog.vue'
import BaseInput from './BaseInput.vue'
import FormNotice from './FormNotice.vue'
import { confirmTextMatches } from './settings.ts'

const open = defineModel<boolean>('open', { default: false })

const {
  title,
  message = '',
  confirmLabel,
  cancelLabel = 'Cancel',
  requireText = '',
  safe,
  busy,
  error = '',
} = defineProps<{
  title: string
  /** What happens, in plain words: "412 items lose this value. This cannot be undone." */
  message?: string
  /** The action, never "OK": "Delete hub", "Remove option". */
  confirmLabel: string
  cancelLabel?: string
  /**
   * The name the reader must type before the action is allowed, for actions that cannot be
   * undone, such as deleting a hub. Leave empty for a plain confirm.
   */
  requireText?: string
  /** The action is not destructive: the confirm button is primary instead of danger. */
  safe?: boolean
  /** The action is running: both buttons wait. */
  busy?: boolean
  /** Why the action failed. The dialog stays open so the reader can retry or cancel. */
  error?: string
}>()

const emit = defineEmits<{ confirm: [] }>()

const typed = ref('')
watch(open, (isOpen) => {
  if (isOpen) typed.value = ''
})

const allowed = computed(() => !requireText || confirmTextMatches(typed.value, requireText))

function submit() {
  if (!allowed.value || busy) return
  emit('confirm')
}
</script>

<template>
  <BaseDialog v-model:open="open" :title="title" :description="message">
    <!-- A form, so Enter in the name field confirms once the name matches. -->
    <form
      class="flex flex-col gap-4"
      :aria-busy="busy ? 'true' : undefined"
      novalidate
      @submit.prevent="submit"
    >
      <BaseInput
        v-if="requireText"
        v-model="typed"
        :label="`Type ${requireText} to confirm`"
        autocomplete="off"
        spellcheck="false"
        autofocus
        :disabled="busy"
      />
      <FormNotice v-if="error">{{ error }}</FormNotice>
      <div class="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
        <!-- Without a name to type, Cancel takes focus first: the safe choice for Enter. -->
        <BaseButton :disabled="busy" :autofocus="!requireText" @click="open = false">{{
          cancelLabel
        }}</BaseButton>
        <BaseButton
          type="submit"
          :variant="safe ? 'primary' : 'outline'"
          :danger="!safe"
          :disabled="!allowed || busy"
          >{{ busy ? 'Working' : confirmLabel }}</BaseButton
        >
      </div>
    </form>
  </BaseDialog>
</template>
