<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import BaseButton from './BaseButton.vue'
import BaseDialog from './BaseDialog.vue'
import BaseInput from './BaseInput.vue'
import FormNotice from './FormNotice.vue'
import { confirmTextMatches, type SettingsState } from './settings.ts'

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
  state = 'ready',
  stateTitle = '',
  stateMessage = '',
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
  /**
   * What the confirm needs before it can be offered, such as the item count of a hub to
   * delete (D52). Anything but `ready` shows a StateBlock instead of the form, so there is
   * nothing to confirm: loading, error, no-permission, and not-found for a thing opened by ID.
   * Empty is a ready state for a confirm (nothing affected is still a question to answer).
   */
  state?: Exclude<SettingsState, 'empty'>
  stateTitle?: string
  stateMessage?: string
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
  <BaseDialog
    v-model:open="open"
    :title="title"
    :description="state === 'ready' ? message : ''"
    :state="state"
    :state-title="stateTitle"
    :state-message="stateMessage"
    :persistent="busy"
  >
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
