<script setup lang="ts">
import type { Folder, FolderAttributesResult, HubDescription } from '@16bit/core'
import { ref } from 'vue'
import { ConfirmDialog } from '../../ui/index.ts'
import FolderAttributesDialog from './FolderAttributesDialog.vue'
import FolderDialog from './FolderDialog.vue'
import { requiredEmptyText, type FolderActionKey } from './schema.ts'
import type { HubSettings } from './useHubSettings.ts'

// The dialogs behind a folder's actions menu (`folderActions` in schema.ts), shared by Hub
// settings → Folders and the hub page's sidebar, so both make the same writes the same way.
// The screen renders the menus and calls `run`.

const { description, model } = defineProps<{
  description: HubDescription
  model: HubSettings
}>()

const emit = defineEmits<{
  /** A sentence for the screen's status line, and whether to focus it (the row is gone). */
  status: [text: string, focus: boolean]
  /** A write succeeded. `deleted` is the folder that is gone, if it was a delete. */
  changed: [deleted: Folder | null]
}>()

// Dialogs, each opened for one folder by ID.
const editOpen = ref(false)
const editId = ref<string | null>(null)
const newParent = ref<string | null>(null)
const attrsOpen = ref(false)
const attrsId = ref(description.hub.id)
const deleteOpen = ref(false)
const deleteTarget = ref<Folder | null>(null)
const deleteBusy = ref(false)
const deleteError = ref('')

/** Runs one action on `folder`. `new` with no folder is a new folder with no parent chosen. */
function run(folder: Folder | null, key: FolderActionKey) {
  if (key === 'new') {
    editId.value = null
    newParent.value = folder?.id ?? null
    editOpen.value = true
    return
  }
  if (!folder) return
  if (key === 'edit') {
    editId.value = folder.id
    editOpen.value = true
  } else if (key === 'attributes') {
    attrsId.value = folder.id
    attrsOpen.value = true
  } else {
    deleteTarget.value = folder
    deleteError.value = ''
    deleteOpen.value = true
  }
}
defineExpose({ run })

function onSaved(folder: Folder, created: boolean) {
  emit('status', created ? `Created ${folder.name}.` : `Saved ${folder.name}.`, false)
  emit('changed', null)
}

function onAttributesSaved(result: FolderAttributesResult) {
  const names = new Map(description.attributes.map((a) => [a.id, a.name]))
  const empties = result.requiredEmpty
    .filter((e) => e.items > 0)
    .map((e) =>
      requiredEmptyText(names.get(e.attributeId) ?? 'An attribute', result.folder.name, e.items),
    )
  emit('status', [`Saved the attributes of ${result.folder.name}.`, ...empties].join(' '), false)
  emit('changed', null)
}

async function confirmDelete() {
  // The folder as it was when the confirm opened: a change made meanwhile is a 409, and one
  // deleted meanwhile a 404, each with its message, rather than a delete of something unseen.
  const target = deleteTarget.value
  if (!target) {
    deleteOpen.value = false
    return
  }
  deleteBusy.value = true
  deleteError.value = ''
  const result = await model.deleteFolder(target)
  deleteBusy.value = false
  if (result.ok) {
    deleteOpen.value = false
    // The row is gone, so focus goes to the status line that says so.
    emit('status', `Deleted ${target.name}.`, true)
    emit('changed', target)
    return
  }
  deleteError.value = result.message
  // After a conflict the page shows their version; deleting again is a choice made on it.
  if (result.kind === 'conflict') {
    deleteTarget.value = description.folders.find((f) => f.id === target.id) ?? target
  }
}
</script>

<template>
  <FolderDialog
    v-model:open="editOpen"
    :description="description"
    :folder-id="editId"
    :parent-id="newParent"
    :model="model"
    @saved="onSaved"
  />
  <FolderAttributesDialog
    v-model:open="attrsOpen"
    :description="description"
    :folder-id="attrsId"
    :model="model"
    @saved="onAttributesSaved"
  />
  <ConfirmDialog
    v-model:open="deleteOpen"
    :title="`Delete ${deleteTarget?.name ?? 'this folder'}?`"
    message="It holds no items and no folders. Its list of attributes goes with it; the hub's attributes stay."
    confirm-label="Delete folder"
    :busy="deleteBusy"
    :error="deleteError"
    @confirm="confirmDelete"
  />
</template>
