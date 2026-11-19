<script setup lang="ts">
import type { Folder, FolderAttributesResult, HubDescription } from '@16bit/core'
import { computed, ref } from 'vue'
import {
  BaseButton,
  ConfirmDialog,
  RowActionsMenu,
  SettingsSection,
  paletteVar,
  type RowAction,
} from '../../ui/index.ts'
import FolderAttributesDialog from './FolderAttributesDialog.vue'
import FolderDialog from './FolderDialog.vue'
import { attributeCount, deleteBlockedReason, requiredEmptyText, settingsTree } from './schema.ts'
import type { HubSettings } from './useHubSettings.ts'

const { description, manages, model } = defineProps<{
  description: HubDescription
  /** `hub.manageSchema`: otherwise the list is read-only, with the reason on the page. */
  manages: boolean
  model: HubSettings
}>()

/** A sentence for the page's status line after a change, and whether to focus it. */
const emit = defineEmits<{ status: [text: string, focus: boolean] }>()

const tree = computed(() => settingsTree(description))
const isHub = (f: Folder) => f.id === description.hub.id

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

function actionsFor(folder: Folder): RowAction[] {
  if (isHub(folder)) {
    return [
      { key: 'attributes', label: 'Attributes' },
      { key: 'new', label: 'New folder inside' },
    ]
  }
  const blocked = deleteBlockedReason(description, folder)
  return [
    { key: 'edit', label: 'Rename, recolour or move' },
    { key: 'attributes', label: 'Attributes' },
    { key: 'new', label: 'New folder inside' },
    { key: 'delete', label: 'Delete folder', danger: true, disabled: !!blocked, reason: blocked },
  ]
}

function onAction(folder: Folder, key: string) {
  if (key === 'edit') {
    editId.value = folder.id
    editOpen.value = true
  } else if (key === 'new') {
    startCreate(folder.id)
  } else if (key === 'attributes') {
    attrsId.value = folder.id
    attrsOpen.value = true
  } else if (key === 'delete') {
    deleteTarget.value = folder
    deleteError.value = ''
    deleteOpen.value = true
  }
}

function startCreate(parentId: string | null = null) {
  editId.value = null
  newParent.value = parentId
  editOpen.value = true
}

function onSaved(folder: Folder, created: boolean) {
  emit('status', created ? `Created ${folder.name}.` : `Saved ${folder.name}.`, false)
}

function onAttributesSaved(result: FolderAttributesResult) {
  const names = new Map(description.attributes.map((a) => [a.id, a.name]))
  const empties = result.requiredEmpty
    .filter((e) => e.items > 0)
    .map((e) =>
      requiredEmptyText(names.get(e.attributeId) ?? 'An attribute', result.folder.name, e.items),
    )
  emit('status', [`Saved the attributes of ${result.folder.name}.`, ...empties].join(' '), false)
}

async function confirmDelete() {
  const target = description.folders.find((f) => f.id === deleteTarget.value?.id)
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
    return
  }
  deleteError.value = result.message
}
</script>

<template>
  <SettingsSection
    title="Folders"
    description="Folders hold items. A folder can be deleted once it holds no items and no folders."
  >
    <template v-if="manages" #actions>
      <BaseButton data-new-folder @click="startCreate()">New folder</BaseButton>
    </template>

    <div class="relative min-w-0 overflow-x-auto">
      <table class="w-full min-w-[420px] border-collapse text-left">
        <caption class="sr-only">
          The hub and its folders, with the items and attributes in each
        </caption>
        <thead>
          <tr class="border-b border-line">
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Folder</th>
            <th scope="col" class="h-8 pr-3 text-right text-caption font-normal text-ink3">
              Items
            </th>
            <th scope="col" class="h-8 pr-3 text-right text-caption font-normal text-ink3">
              Attributes
            </th>
            <th v-if="manages" scope="col" class="h-8 w-10 text-caption font-normal text-ink3">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in tree"
            :key="entry.folder.id"
            class="border-b border-line"
            data-folder-row
            :data-folder-id="entry.folder.id"
          >
            <th scope="row" class="h-[38px] pr-3 font-normal">
              <span
                class="inline-flex min-w-0 items-center gap-2"
                :style="{ paddingLeft: `${entry.depth * 16}px` }"
              >
                <span
                  aria-hidden="true"
                  class="size-2 shrink-0"
                  :style="{ background: paletteVar(entry.folder.color) }"
                />
                <span :class="isHub(entry.folder) && 'font-medium'">{{ entry.folder.name }}</span>
                <span v-if="isHub(entry.folder)" class="text-secondary text-ink3"
                  >Items directly in the hub</span
                >
              </span>
            </th>
            <td class="h-[38px] pr-3 text-right tabular-nums">{{ entry.folder.itemCount }}</td>
            <td class="h-[38px] pr-3 text-right tabular-nums">
              {{ attributeCount(description, entry.folder.id) }}
            </td>
            <td v-if="manages" class="h-[38px] text-right">
              <RowActionsMenu
                :label="`Actions for ${entry.folder.name}`"
                :items="actionsFor(entry.folder)"
                @select="onAction(entry.folder, $event)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="tree.length === 1" class="m-0 text-ink2" data-folders-empty>
      This hub has no folders yet. Items sit directly in the hub until you add one.
    </p>

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
  </SettingsSection>
</template>
