<script setup lang="ts">
import type { CreateHub, HubListEntry, PaletteColor } from '@16bit/core'
import { nextTick, ref, useId, useTemplateRef, watch } from 'vue'
import {
  BaseButton,
  BaseDialog,
  BaseInput,
  FormNotice,
  PALETTE_COLORS,
  PalettePicker,
} from '../../ui/index.ts'
import {
  PREFIX_HINT,
  hubRequest,
  nextHubColor,
  suggestPrefix,
  type CreateHubResult,
  type HubDraftErrors,
} from './newHub.ts'

const open = defineModel<boolean>('open', { default: false })

const {
  workspaceName,
  usedColors = [],
  create,
} = defineProps<{
  workspaceName: string
  /** Colours the workspace's hubs already use: the first free one is chosen to start. */
  usedColors?: readonly PaletteColor[]
  /** Sends the create. The dialog stays open, with the reason, when it is refused. */
  create: (body: CreateHub) => Promise<CreateHubResult>
}>()

const emit = defineEmits<{ created: [hub: Extract<HubListEntry, { access: 'granted' }>] }>()

const formId = useId()
const form = useTemplateRef<HTMLFormElement>('form')
const name = ref('')
const idPrefix = ref('')
/** The reader typed a prefix of their own: it no longer follows the name. */
const prefixEdited = ref(false)
const color = ref<PaletteColor | null>(null)
const errors = ref<HubDraftErrors>({})
const error = ref('')
const busy = ref(false)

watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    name.value = ''
    idPrefix.value = ''
    prefixEdited.value = false
    color.value = nextHubColor(usedColors, PALETTE_COLORS)
    errors.value = {}
    error.value = ''
  },
  { immediate: true },
)

watch(name, (next) => {
  if (prefixEdited.value) return
  const suggested = suggestPrefix(next)
  if (suggested === idPrefix.value) return
  idPrefix.value = suggested
  // A refusal of the old prefix (prefix_taken) no longer applies.
  delete errors.value.idPrefix
})

// Shown in capitals as typed: the prefix is permanent, so the field shows what is stored.
function onPrefix(value: string) {
  idPrefix.value = value.toUpperCase()
  // A refusal of the old prefix (prefix_taken) no longer applies.
  delete errors.value.idPrefix
  // Clearing the field hands it back to the name.
  prefixEdited.value = value.trim() !== ''
}

async function submit() {
  if (busy.value) return
  const request = hubRequest({ name: name.value, idPrefix: idPrefix.value, color: color.value })
  if (!request.ok) {
    errors.value = request.errors
    // The picker has no error line of its own; a colour is chosen from the start anyway.
    error.value = request.errors.color ?? ''
    return
  }
  errors.value = {}
  error.value = ''
  busy.value = true
  const result = await create(request.body)
  busy.value = false
  if (!result.ok) {
    if (!result.field) {
      error.value = result.message
      return
    }
    errors.value = { [result.field]: result.message }
    // "Create hub" was disabled while busy, so focus is lost: move it to the field, whose
    // description now carries the error, so a screen reader announces it.
    await nextTick()
    form.value?.querySelector<HTMLInputElement>('[data-hub-prefix]')?.focus()
    return
  }
  open.value = false
  emit('created', result.hub)
}
</script>

<template>
  <BaseDialog
    v-model:open="open"
    title="New hub"
    :description="`In ${workspaceName}. You become its hub admin.`"
    :persistent="busy"
  >
    <form
      :id="formId"
      ref="form"
      class="flex flex-col gap-4"
      novalidate
      data-new-hub
      @submit.prevent="submit"
    >
      <BaseInput
        v-model="name"
        label="Name"
        :error="errors.name"
        :disabled="busy"
        maxlength="200"
        autofocus
        data-hub-name
      />
      <BaseInput
        :model-value="idPrefix"
        label="ID prefix"
        :hint="PREFIX_HINT"
        :error="errors.idPrefix"
        :disabled="busy"
        mono
        maxlength="10"
        autocapitalize="characters"
        spellcheck="false"
        data-hub-prefix
        @update:model-value="onPrefix"
      />
      <PalettePicker v-model="color" label="Colour" :disabled="busy" />
      <FormNotice v-if="error" data-new-hub-error>{{ error }}</FormNotice>
    </form>
    <template #footer>
      <BaseButton :disabled="busy" @click="open = false">Cancel</BaseButton>
      <BaseButton variant="primary" type="submit" :form="formId" :disabled="busy">{{
        busy ? 'Creating…' : 'Create hub'
      }}</BaseButton>
    </template>
  </BaseDialog>
</template>
