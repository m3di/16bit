<script setup lang="ts">
import type { Folder, HubDescription } from '@16bit/core'
import { computed, useTemplateRef } from 'vue'
import {
  BaseButton,
  DataTable,
  RowActionsMenu,
  SettingsSection,
  paletteVar,
  type TableColumn,
} from '../../ui/index.ts'
import FolderActions from './FolderActions.vue'
import { attributeCount, folderActions, settingsTree, type FolderActionKey } from './schema.ts'
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
const rows = computed(() => tree.value.map((entry) => ({ id: entry.folder.id, ...entry })))
const columns = computed((): TableColumn[] => [
  { key: 'name', label: 'Folder', rowHeader: true, wrap: true },
  { key: 'items', label: 'Items', align: 'end' },
  { key: 'attributes', label: 'Attributes', align: 'end' },
  ...(manages
    ? [{ key: 'actions', label: 'Actions', labelHidden: true, align: 'end', shrink: true } as const]
    : []),
])

const actions = useTemplateRef<InstanceType<typeof FolderActions>>('actions')
</script>

<template>
  <SettingsSection
    title="Folders"
    description="Folders hold items. A folder can be deleted once it holds no items and no folders."
  >
    <template v-if="manages" #actions>
      <BaseButton data-new-folder @click="actions?.run(null, 'new')">New folder</BaseButton>
    </template>

    <DataTable
      mode="static"
      caption="The hub and its folders, with the items and attributes in each"
      :columns="columns"
      :rows="rows"
      :min-width="420"
      :row-attrs="(row) => ({ 'data-folder-row': true, 'data-folder-id': row.id })"
    >
      <template #cell="{ row: entry, column }">
        <span
          v-if="column.key === 'name'"
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
        <template v-else-if="column.key === 'items'">{{ entry.ownCount ?? '' }}</template>
        <template v-else-if="column.key === 'attributes'">{{
          attributeCount(description, entry.folder.id)
        }}</template>
        <RowActionsMenu
          v-else-if="column.key === 'actions'"
          :label="`Actions for ${entry.folder.name}`"
          :items="folderActions(description, entry.folder)"
          @select="actions?.run(entry.folder, $event as FolderActionKey)"
        />
      </template>
    </DataTable>
    <p v-if="tree.length === 1" class="m-0 text-ink2" data-folders-empty>
      This hub has no folders yet. Items sit directly in the hub until you add one.
    </p>

    <FolderActions
      ref="actions"
      :description="description"
      :model="model"
      @status="(text, focus) => emit('status', text, focus)"
    />
  </SettingsSection>
</template>
