<script setup lang="ts">
import type { Folder, HubDescription, PaletteColor } from '@16bit/core'
import { computed, ref, useId, watch } from 'vue'
import {
  BaseButton,
  BaseDialog,
  BaseInput,
  BaseSelect,
  CheckboxField,
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

const current = () =>
  folderId ? (description.folders.find((f) => f.id === folderId) ?? null) : null
// The folder as it was when the dialog opened: its version goes with the save, so a change made
// meanwhile (the hub page reads the hub again live) is a 409, never silently overwritten. Only a
// conflict moves it on, to the version the page now shows.
const folder = ref<Folder | null>(null)

const formId = useId()
const name = ref('')
const color = ref<PaletteColor | null>(null)
const parent = ref('')
const viewsOnly = ref(false)
const nameError = ref('')
const error = ref('')
const busy = ref(false)

watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    folder.value = current()
    const f = folder.value
    name.value = f?.name ?? ''
    color.value = f?.color ?? nextFolderColor(description, PALETTE_COLORS)
    parent.value = f?.parentId ?? parentId ?? description.hub.id
    viewsOnly.value = false
    nameError.value = ''
    error.value = ''
  },
  { immediate: true },
)

const parents = computed(() => parentChoices(description, folderId))
const title = computed(() => (folderId ? 'Edit folder' : 'New folder'))

async function submit() {
  const trimmed = name.value.trim()
  nameError.value = trimmed ? '' : 'Name the folder.'
  if (nameError.value || !color.value || busy.value) return
  busy.value = true
  error.value = ''
  let result: WriteResult<Folder>
  const f = folder.value
  if (folderId && !f) {
    // Opened for a folder that was already gone: never fall through to creating one.
    busy.value = false
    error.value = 'This folder is no longer available. Nothing was saved.'
    return
  }
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
    result = await model.createFolder({
      parentId: parent.value,
      name: trimmed,
      color: color.value,
      ...(viewsOnly.value ? { viewsOnly: true } : {}),
    })
  }
  busy.value = false
  if (result.ok) {
    open.value = false
    emit('saved', result.data, !f)
    return
  }
  error.value = result.message
  if (result.kind === 'conflict') folder.value = current()
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
      <!-- Fixed when the folder is created (D76), so only a new folder offers it. -->
      <CheckboxField
        v-if="!folderId"
        v-model="viewsOnly"
        label="Views only"
        hint="Holds no items and only shows its root view, like a home page. This cannot be changed later."
        data-folder-views-only
      />
      <FormNotice v-if="error" data-folder-error>{{ error }}</FormNotice>
    </form>
    <template #footer>
      <BaseButton :disabled="busy" @click="open = false">Cancel</BaseButton>
      <BaseButton variant="primary" type="submit" :form="formId" :disabled="busy">{{
        busy ? 'Saving…' : folderId ? 'Save folder' : 'Create folder'
      }}</BaseButton>
    </template>
  </BaseDialog>
</template>
