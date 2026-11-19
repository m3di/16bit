<script setup lang="ts">
import type { Attribute, HubDescription } from '@16bit/core'
import { computed, nextTick, ref } from 'vue'
import {
  BaseButton,
  ConfirmDialog,
  RowActionsMenu,
  SettingsSection,
  type RowAction,
} from '../../ui/index.ts'
import AttributeDialog from './AttributeDialog.vue'
import { strippedValuesMessage, typeLabel, usedIn } from './schema.ts'
import type { HubSettings } from './useHubSettings.ts'

const { description, manages, model } = defineProps<{
  description: HubDescription
  manages: boolean
  model: HubSettings
}>()

const emit = defineEmits<{ status: [text: string, focus: boolean] }>()

const attributes = computed(() =>
  [...description.attributes].sort((a, b) => a.name.localeCompare(b.name)),
)
const isTitle = (a: Attribute) => description.hub.titleAttributeId === a.id

const editOpen = ref(false)
const editId = ref<string | null>(null)

const deleteOpen = ref(false)
const deleteTarget = ref<Attribute | null>(null)
const deleteBusy = ref(false)
const deleteError = ref('')
/** The server's count of items holding a value, once it has asked for one (D51). */
const deleteAffected = ref<number | null>(null)
/**
 * The second question, with the count. It is its own dialog, opened when the count arrives, so
 * a screen reader reads the count as the dialog opens and Cancel, not the destructive action,
 * takes focus.
 */
const countOpen = ref(false)

const actions: RowAction[] = [
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete attribute', danger: true },
]

function onAction(attribute: Attribute, key: string) {
  if (key === 'edit') {
    editId.value = attribute.id
    editOpen.value = true
  } else if (key === 'delete') {
    deleteTarget.value = attribute
    deleteAffected.value = null
    deleteError.value = ''
    deleteOpen.value = true
  }
}

function startCreate() {
  editId.value = null
  editOpen.value = true
}

function onSaved(attribute: Attribute, created: boolean) {
  emit('status', created ? `Created ${attribute.name}.` : `Saved ${attribute.name}.`, false)
}

const titleNote = (a: Attribute) =>
  isTitle(a) ? ' It is the title attribute, so items will show only their ID.' : ''

const deleteMessage = computed(() => {
  const a = deleteTarget.value
  if (!a) return ''
  const places = usedIn(description, a.id)
  const where = places.length ? ` It leaves ${places.join(', ')}.` : ''
  return `This cannot be undone.${where}${titleNote(a)} If items hold a value for it, you will see how many before anything is cleared.`
})

const countMessage = computed(() => {
  const a = deleteTarget.value
  if (!a || deleteAffected.value === null) return ''
  return strippedValuesMessage('attribute', a.name, deleteAffected.value) + titleNote(a)
})

async function confirmDelete() {
  const target = description.attributes.find((a) => a.id === deleteTarget.value?.id)
  if (!target) {
    deleteOpen.value = false
    countOpen.value = false
    return
  }
  deleteBusy.value = true
  deleteError.value = ''
  const result = await model.deleteAttribute(target, deleteAffected.value ?? undefined)
  deleteBusy.value = false
  if (result.ok) {
    deleteOpen.value = false
    countOpen.value = false
    emit('status', `Deleted ${target.name}.`, true)
    return
  }
  if (result.kind === 'confirm') {
    // Items hold a value: ask again with the count, in a dialog that opens fresh. If the count
    // moved while the second question was open, it closes and opens again with the new one.
    deleteAffected.value = result.affected
    deleteOpen.value = false
    countOpen.value = false
    await nextTick()
    countOpen.value = true
    return
  }
  deleteError.value = result.message
}
</script>

<template>
  <SettingsSection
    title="Attributes"
    :state="attributes.length ? 'ready' : 'empty'"
    state-title="No attributes yet"
    :state-message="
      manages
        ? 'Attributes are the fields items have. Create one, then add it to the folders that need it.'
        : 'This hub has no attributes yet.'
    "
    description="An attribute's type is fixed once it exists. To use another type, add a new attribute."
  >
    <template v-if="manages" #actions>
      <BaseButton data-new-attribute @click="startCreate">New attribute</BaseButton>
    </template>
    <template v-if="manages && !attributes.length" #state-action>
      <BaseButton data-new-attribute @click="startCreate">New attribute</BaseButton>
    </template>

    <div class="relative min-w-0 overflow-x-auto">
      <table class="w-full min-w-[480px] border-collapse text-left">
        <caption class="sr-only">
          The hub's attributes, their types and the folders that show them
        </caption>
        <thead>
          <tr class="border-b border-line">
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Name</th>
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Type</th>
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Used in</th>
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Filter and sort</th>
            <th v-if="manages" scope="col" class="h-8 w-10 text-caption font-normal text-ink3">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="a in attributes"
            :key="a.id"
            class="border-b border-line"
            data-attribute-row
            :data-attribute-id="a.id"
          >
            <th scope="row" class="h-[38px] pr-3 font-normal">
              <span class="inline-flex flex-wrap items-baseline gap-x-2">
                <span>{{ a.name }}</span>
                <span v-if="isTitle(a)" class="text-secondary text-ink3">Title</span>
              </span>
            </th>
            <td class="h-[38px] pr-3 text-ink3">{{ typeLabel(a.type) }}</td>
            <td class="h-[38px] pr-3">
              <span v-if="usedIn(description, a.id).length">{{
                usedIn(description, a.id).join(', ')
              }}</span>
              <span v-else class="text-ink3">No folder</span>
            </td>
            <td class="h-[38px] pr-3">{{ a.indexed ? 'On' : 'Off' }}</td>
            <td v-if="manages" class="h-[38px] text-right">
              <RowActionsMenu
                :label="`Actions for ${a.name}`"
                :items="actions"
                @select="onAction(a, $event)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </SettingsSection>

  <AttributeDialog
    v-model:open="editOpen"
    :description="description"
    :attribute-id="editId"
    :model="model"
    @saved="onSaved"
  />
  <ConfirmDialog
    v-model:open="deleteOpen"
    :title="`Delete ${deleteTarget?.name ?? 'this attribute'}?`"
    :message="deleteMessage"
    confirm-label="Delete attribute"
    :busy="deleteBusy"
    :error="deleteError"
    @confirm="confirmDelete"
  />
  <ConfirmDialog
    v-model:open="countOpen"
    :title="`Clear values and delete ${deleteTarget?.name ?? 'this attribute'}?`"
    :message="countMessage"
    confirm-label="Clear values and delete"
    :busy="deleteBusy"
    :error="deleteError"
    @confirm="confirmDelete"
  />
</template>
