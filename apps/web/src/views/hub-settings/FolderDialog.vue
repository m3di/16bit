<script setup lang="ts">
import type { Folder, HubDescription, PaletteColor } from '@16bit/core'
import { computed, ref, useId, watch } from 'vue'
import {
  BaseButton,
  BaseDialog,
  BaseInput,
  BaseSelect,
  FormNotice,
  PALETTE_COLORS,
  PalettePicker,
} from '../../ui/index.ts'
import { nextFolderColor, parentChoices } from './schema.ts'
import type { HubSettings, WriteResult } from './useHubSettings.ts'

const open = defineModel<boolean>('open', { default: false })

const {
  description,
  folderId,
  parentId = null,
  model,
} = defineProps<{
  description: HubDescription
  /** The folder to change, or null for a new folder. */
  folderId: string | null
  /** For a new folder: where it goes first. */
  parentId?: string | null
  model: HubSettings
}>()

const emit = defineEmits<{ saved: [folder: Folder, created: boolean] }>()

// Read from the page each time: a conflict may have put a newer version there.
const folder = computed(() =>
  folderId ? (description.folders.find((f) => f.id === folderId) ?? null) : null,
)

const formId = useId()
const name = ref('')
const color = ref<PaletteColor | null>(null)
const parent = ref('')
const nameError = ref('')
const error = ref('')
const busy = ref(false)

watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    const f = folder.value
    name.value = f?.name ?? ''
    color.value = f?.color ?? nextFolderColor(description, PALETTE_COLORS)
    parent.value = f?.parentId ?? parentId ?? description.hub.id
    nameError.value = ''
    error.value = ''
  },
  { immediate: true },
)

const parents = computed(() => parentChoices(description, folderId))
const title = computed(() => (folder.value ? `Edit ${folder.value.name}` : 'New folder'))

async function submit() {
  const trimmed = name.value.trim()
  nameError.value = trimmed ? '' : 'Name the folder.'
  if (nameError.value || !color.value || busy.value) return
  busy.value = true
  error.value = ''
  let result: WriteResult<Folder>
  const f = folder.value
  if (f) {
    const change = {
      ...(trimmed !== f.name && { name: trimmed }),
      ...(color.value !== f.color && { color: color.value }),
      ...(parent.value !== f.parentId && { parentId: parent.value }),
    }
    if (Object.keys(change).length === 0) {
      busy.value = false
      open.value = false
      return
    }
    result = await model.updateFolder(f, change)
  } else {
    result = await model.createFolder({ parentId: parent.value, name: trimmed, color: color.value })
  }
  busy.value = false
  if (result.ok) {
    open.value = false
    emit('saved', result.data, !f)
    return
  }
  error.value = result.message
  if (result.kind === 'conflict' && folder.value) {
    // Show their version, so saving again is a choice made on what is there now.
    name.value = folder.value.name
    color.value = folder.value.color
    parent.value = folder.value.parentId ?? description.hub.id
  }
}
</script>

<template>
  <BaseDialog v-model:open="open" :title="title" :persistent="busy">
    <form :id="formId" class="flex flex-col gap-4" novalidate @submit.prevent="submit">
      <BaseInput
        v-model="name"
        label="Name"
        :error="nameError"
        maxlength="200"
        autofocus
        data-folder-name
      />
      <BaseSelect v-model="parent" label="Inside" :options="parents" data-folder-parent />
      <PalettePicker v-model="color" label="Colour" size="sm" />
      <FormNotice v-if="error" data-folder-error>{{ error }}</FormNotice>
    </form>
    <template #footer>
      <BaseButton :disabled="busy" @click="open = false">Cancel</BaseButton>
      <BaseButton variant="primary" type="submit" :form="formId" :disabled="busy">{{
        busy ? 'Saving…' : folder ? 'Save folder' : 'Create folder'
      }}</BaseButton>
    </template>
  </BaseDialog>
</template>
