<script setup lang="ts">
import type { Folder, FolderAttributesResult, HubDescription } from '@16bit/core'
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import {
  BaseButton,
  BaseDialog,
  BaseSelect,
  FormNotice,
  RowActionsMenu,
  ToggleSwitch,
  moveOption,
  type RowAction,
} from '../../ui/index.ts'
import { folderColumns } from '../hub/useHub.ts'
import { items, typeLabel } from './schema.ts'
import type { HubSettings } from './useHubSettings.ts'

const open = defineModel<boolean>('open', { default: false })

const { description, folderId, model } = defineProps<{
  description: HubDescription
  /** The folder, or the hub's own ID for the hub's items. */
  folderId: string
  model: HubSettings
}>()

const emit = defineEmits<{ saved: [result: FolderAttributesResult] }>()

interface Row {
  attributeId: string
  required: boolean
}

const id = useId()
const root = useTemplateRef<HTMLElement>('root')
const current = (): Folder | null =>
  folderId === description.hub.id
    ? description.hub
    : (description.folders.find((f) => f.id === folderId) ?? null)
// The folder as it was when the dialog opened: its version goes with the save, so a change made
// meanwhile (the hub page reads the hub again live) is a 409, never silently overwritten. Only a
// conflict moves it on, to the version the page now shows.
const folder = ref<Folder | null>(null)
const byId = computed(() => new Map(description.attributes.map((a) => [a.id, a])))

const nameOf = (attributeId: string) => byId.value.get(attributeId)?.name ?? 'Unknown attribute'
const typeOf = (attributeId: string) => {
  const attribute = byId.value.get(attributeId)
  return attribute ? typeLabel(attribute.type) : ''
}

const draft = ref<Row[]>([])
const attach = ref('')
const error = ref('')
const busy = ref(false)
/** Items of this folder that leave each required attribute empty (D51), from a dry run. */
const empty = ref<Record<string, number>>({})
const countsNote = ref('')

function reset() {
  draft.value = folderColumns(description, folderId).map((c) => ({
    attributeId: c.attribute.id,
    required: c.required,
  }))
}

watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    folder.value = current()
    reset()
    attach.value = ''
    error.value = ''
    empty.value = {}
    countsNote.value = ''
  },
  { immediate: true },
)

const unattached = computed(() => {
  const shown = new Set(draft.value.map((r) => r.attributeId))
  return description.attributes
    .filter((a) => !shown.has(a.id))
    .map((a) => ({ value: a.id, label: `${a.name} (${typeLabel(a.type)})` }))
})

// When the set of required attributes changes, ask the server, without saving, how many items
// would leave each one empty, so the count is on screen before the reader saves (D51). Order
// and optional attributes do not change the counts, so they send nothing. A short wait lets a
// few quick toggles end in one request.
const DRY_RUN_WAIT = 250
const requiredKey = computed(() =>
  draft.value
    .filter((r) => r.required)
    .map((r) => r.attributeId)
    .sort()
    .join(','),
)
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined

function scheduleDryRun() {
  clearTimeout(timer)
  const mine = ++seq
  if (!open.value || !requiredKey.value) {
    empty.value = {}
    countsNote.value = ''
    return
  }
  timer = setTimeout(() => void dryRun(mine), DRY_RUN_WAIT)
}

async function dryRun(mine: number) {
  const f = folder.value
  if (!f) return
  const result = await model.setFolderAttributes(f, draft.value, true)
  if (mine !== seq) return
  if (result.ok) {
    empty.value = Object.fromEntries(result.data.requiredEmpty.map((e) => [e.attributeId, e.items]))
    countsNote.value = ''
  } else if (result.kind === 'conflict') {
    // The reader's draft stays: they are still editing. The page now holds the newer version,
    // so count again against it, and say that saving will replace the other change.
    folder.value = current()
    error.value =
      'Someone else changed the attributes of this folder while you were editing. Saving now replaces their version with yours; cancel to see theirs.'
    scheduleDryRun()
  } else {
    empty.value = {}
    countsNote.value =
      `How many items leave a required attribute empty could not be counted. ${result.message}`.trim()
  }
}

watch([requiredKey, open], scheduleDryRun)
onBeforeUnmount(() => {
  clearTimeout(timer)
})

function actionsFor(index: number): RowAction[] {
  return [
    { key: 'up', label: 'Move up', disabled: index === 0, reason: 'Already first' },
    {
      key: 'down',
      label: 'Move down',
      disabled: index === draft.value.length - 1,
      reason: 'Already last',
    },
    { key: 'remove', label: 'Remove from folder', danger: true },
  ]
}

async function onAction(index: number, key: string) {
  if (key === 'up' || key === 'down') {
    draft.value = moveOption(draft.value, index, key === 'up' ? -1 : 1)
    return
  }
  draft.value = draft.value.filter((_, i) => i !== index)
  // Focus the row that took its place, else the one before, else the attach field.
  await nextTick()
  const menus = root.value?.querySelectorAll<HTMLElement>('[data-attr-row] [aria-haspopup="menu"]')
  const next = menus?.[index] ?? menus?.[index - 1]
  ;(next ?? root.value?.querySelector<HTMLElement>('[data-attach] select'))?.focus()
}

function add() {
  if (!attach.value) return
  draft.value = [...draft.value, { attributeId: attach.value, required: false }]
  attach.value = ''
}

async function save() {
  const f = folder.value
  if (!f || busy.value) return
  busy.value = true
  error.value = ''
  const result = await model.setFolderAttributes(f, draft.value, false)
  busy.value = false
  if (result.ok) {
    open.value = false
    emit('saved', result.data)
    return
  }
  error.value = result.message
  if (result.kind === 'conflict') {
    folder.value = current()
    reset()
  }
}

const title = computed(() => `Attributes in ${folder.value?.name ?? 'this folder'}`)
</script>

<template>
  <BaseDialog
    v-model:open="open"
    :title="title"
    description="Items in this folder show these attributes, in this order. A required attribute must be filled when an item is created."
    width="lg"
    :persistent="busy"
    :state="folder ? 'ready' : 'not-found'"
    state-title="This folder is not available"
    state-message="It may have been deleted. The list has been read again."
  >
    <div ref="root" class="flex flex-col gap-3">
      <p v-if="draft.length === 0" class="m-0 text-ink2" data-attr-empty>
        This folder shows no attributes yet. Its items show only their ID.
      </p>
      <span :id="`${id}-list`" class="sr-only">Attributes in order</span>
      <ol
        v-if="draft.length"
        :aria-labelledby="`${id}-list`"
        class="m-0 flex list-none flex-col p-0"
      >
        <li
          v-for="(row, i) in draft"
          :key="row.attributeId"
          class="flex flex-col gap-1 border-b border-line py-1.5"
          data-attr-row
          :data-attribute-id="row.attributeId"
        >
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span class="flex min-w-0 flex-[1_1_160px] flex-wrap items-baseline gap-x-2">
              <span class="text-ink">{{ nameOf(row.attributeId) }}</span>
              <span class="text-secondary text-ink3">{{ typeOf(row.attributeId) }}</span>
            </span>
            <span class="flex items-center gap-2">
              <!-- The switch is named with the attribute; the visible word is for the eye. -->
              <span aria-hidden="true" class="text-secondary text-ink3">Required</span>
              <ToggleSwitch
                v-model="row.required"
                :label="`${nameOf(row.attributeId)} is required`"
                label-hidden
                :disabled="busy"
              />
            </span>
            <RowActionsMenu
              :label="`Actions for ${nameOf(row.attributeId)}`"
              :items="actionsFor(i)"
              @select="onAction(i, $event)"
            />
          </div>
          <span
            v-if="row.required && (empty[row.attributeId] ?? 0) > 0"
            class="text-secondary text-ink2"
            data-required-empty
            >{{ items(empty[row.attributeId] ?? 0) }} in {{ folder?.name }}
            {{ empty[row.attributeId] === 1 ? 'leaves' : 'leave' }} it empty. They stay valid until
            someone edits that value.</span
          >
        </li>
      </ol>
      <p v-if="countsNote" class="m-0 text-secondary text-ink3" data-counts-note>
        {{ countsNote }}
      </p>

      <div v-if="unattached.length" class="flex flex-wrap items-end gap-2" data-attach>
        <div class="min-w-0 flex-[1_1_220px]">
          <BaseSelect
            v-model="attach"
            label="Add an attribute"
            :options="[{ value: '', label: 'Choose an attribute' }, ...unattached]"
          />
        </div>
        <BaseButton :disabled="!attach || busy" data-attach-add @click="add">Add</BaseButton>
      </div>
      <p v-else-if="description.attributes.length === 0" class="m-0 text-secondary text-ink3">
        This hub has no attributes yet. Create them under Attributes.
      </p>

      <FormNotice v-if="error" data-attr-error>{{ error }}</FormNotice>
    </div>
    <template #footer>
      <BaseButton :disabled="busy" @click="open = false">Cancel</BaseButton>
      <BaseButton variant="primary" :disabled="busy || !folder" data-attr-save @click="save">{{
        busy ? 'Saving…' : 'Save attributes'
      }}</BaseButton>
    </template>
  </BaseDialog>
</template>
