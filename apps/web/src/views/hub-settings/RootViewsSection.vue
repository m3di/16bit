<script setup lang="ts">
import type { BlockTypeName, HubDescription } from '@16bit/core'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  BaseButton,
  BaseSelect,
  ConfirmDialog,
  FormNotice,
  SettingsSection,
  type SettingsState,
} from '../../ui/index.ts'
import BlockForm from '../composer/BlockForm.vue'
import ComposerPreview from '../composer/ComposerPreview.vue'
import OutlineNode from '../composer/OutlineNode.vue'
import {
  BLOCK_LABELS,
  childTypes,
  composerSchema,
  ownerOf,
  type TreeError,
} from '../composer/tree.ts'
import { useViewComposer } from '../composer/useViewComposer.ts'
import type { ViewSource, ViewWrites } from '../root-view/source.ts'
import { settingsTree } from './schema.ts'
import type { HubAccess } from './useHubAccess.ts'

// Root views (D76 to D78, Q10): hub admins compose the view each folder opens on. Everyone else
// gets the settings no-permission state. The composer has no mockup (DESIGN.md).

const { description, manages, access, api, me } = defineProps<{
  description: HubDescription
  /** `hub.manageSchema` (D78): only hub admins compose views. */
  manages: boolean
  access: HubAccess
  api: ViewSource & ViewWrites
  /** The reader's principal ID, for `$me` in the preview. */
  me: string | null
}>()
const emit = defineEmits<{ status: [text: string, focus: boolean] }>()

const route = useRoute()
const router = useRouter()

const schema = computed(() => composerSchema(description))
const composer = useViewComposer({ api, schema: () => schema.value })

// ---- the folder being composed: `?folder=`, else the one the hub opens on, else the root ----
const folders = computed(() =>
  settingsTree(description).map((entry) => ({
    value: entry.folder.id,
    label: `${'– '.repeat(entry.depth)}${entry.folder.name}${entry.folder.viewsOnly ? ' (views only)' : ''}`,
  })),
)
const folderId = computed(() => {
  const asked = route.query['folder']
  const known = (id: unknown): id is string =>
    typeof id === 'string' && folders.value.some((f) => f.value === id)
  if (known(asked)) return asked
  const opens = description.hub.opensOnFolderId
  return known(opens) ? opens : description.hub.id
})
const folder = computed(() =>
  folderId.value === description.hub.id
    ? description.hub
    : description.folders.find((f) => f.id === folderId.value),
)
function chooseFolder(id: string) {
  void router.replace({ query: { ...route.query, folder: id } })
}
watch(
  folderId,
  (id) => {
    if (manages) void composer.load(id)
  },
  { immediate: true },
)
onMounted(() => {
  if (manages && access.members.value.state !== 'ready') void access.loadMembers()
})
const people = computed(() =>
  access.members.value.state === 'ready' ? access.members.value.data : [],
)

// ---- state ---------------------------------------------------------------------------------
const state = computed((): SettingsState => {
  if (!manages) return 'no-permission'
  const v = composer.view.value
  if (v.state === 'loading') return 'loading'
  if (v.state === 'error')
    return v.error.isNotFound ? 'not-found' : v.error.isNoPermission ? 'no-permission' : 'error'
  return 'ready'
})
const stateText = computed(() => {
  switch (state.value) {
    case 'no-permission':
      return {
        title: 'Only hub admins can compose root views',
        message: 'Each folder opens on the view a hub admin composed for it, or on its default.',
      }
    case 'not-found':
      return { title: 'This folder is not available', message: 'It may have been deleted.' }
    case 'error':
      return {
        title: 'The view could not be loaded',
        message: composer.view.value.state === 'error' ? composer.view.value.error.message : '',
      }
    default:
      return { title: '', message: '' }
  }
})

const saved = composer.saved
const draft = composer.draft
const savedLine = computed(() => {
  const v = saved.value
  if (!v) return ''
  return v.stored
    ? `Saved view, version ${String(v.version)}.`
    : 'No view is saved for this folder: it opens on its default view. Saving stores this one.'
})

// ---- problems: by block, and for the whole view ---------------------------------------------
const owned = computed(() => {
  const byBlock = new Map<string, TreeError[]>()
  const whole: TreeError[] = []
  for (const e of composer.errors.value) {
    const owner = ownerOf(e, composer.blocks.value)
    if (!owner) whole.push(e)
    else byBlock.set(owner.block.id, [...(byBlock.get(owner.block.id) ?? []), e])
  }
  return { byBlock, whole }
})
const counts = computed(
  () => new Map([...owned.value.byBlock].map(([id, list]) => [id, list.length])),
)

// ---- outline and adding ------------------------------------------------------------------
const selected = computed(
  () => composer.blocks.value.find((l) => l.block.id === composer.selected.value) ?? null,
)
const addTarget = computed(() => {
  // Into the selected block if it holds blocks, else beside it, in its parent.
  const s = selected.value
  if (!s) return null
  if (childTypes(s.block.type).length > 0) return s.block
  return s.parent
})
const addable = computed(() =>
  addTarget.value
    ? childTypes(addTarget.value.type).map((t) => ({ value: t, label: BLOCK_LABELS[t] }))
    : [],
)
const addType = ref<string>('')
watch(
  addable,
  (list) => {
    if (!list.some((o) => o.value === addType.value)) addType.value = list[0]?.value ?? ''
  },
  { immediate: true },
)
function add() {
  const target = addTarget.value
  if (!target || !addType.value) return
  const id = composer.add(target.id, addType.value as BlockTypeName)
  emit(
    'status',
    id
      ? `Added ${BLOCK_LABELS[addType.value as BlockTypeName]} to ${BLOCK_LABELS[target.type]}.`
      : 'This block cannot hold more blocks.',
    false,
  )
}
function remove(id: string) {
  const at = composer.blocks.value.find((l) => l.block.id === id)
  composer.remove(id)
  if (at) emit('status', `Removed ${BLOCK_LABELS[at.block.type]} ${id}.`, false)
}

// ---- save, discard, reset ------------------------------------------------------------------
async function save() {
  if (await composer.save()) emit('status', 'Root view saved.', false)
}
const confirmReset = ref(false)
async function reset() {
  // Either way the dialog closes: the outcome is said in the notice above the composer.
  await composer.reset()
  confirmReset.value = false
}
const busy = computed(() => composer.busy.value !== null)
</script>

<template>
  <SettingsSection
    title="Root views"
    :state="state"
    :state-title="stateText.title"
    :state-message="stateText.message"
    data-root-views-section
  >
    <template v-if="state === 'error'" #state-action>
      <BaseButton size="sm" @click="composer.load(folderId)">Try again</BaseButton>
    </template>
    <template #actions>
      <span class="text-secondary text-ink3" aria-live="polite" data-composer-state>{{
        busy
          ? composer.busy.value === 'save'
            ? 'Saving'
            : 'Resetting'
          : composer.dirty.value
            ? 'Unsaved changes'
            : ''
      }}</span>
    </template>

    <div class="flex max-w-[560px] flex-col gap-1">
      <BaseSelect
        :model-value="folderId"
        label="Folder"
        :options="folders"
        :disabled="composer.dirty.value || busy"
        :hint="
          composer.dirty.value
            ? 'Save or discard your changes to compose another folder.'
            : savedLine
        "
        data-composer-folder
        @update:model-value="chooseFolder"
      />
    </div>

    <FormNotice
      v-if="composer.notice.value"
      :tone="composer.notice.value.tone === 'info' ? 'info' : 'error'"
      data-composer-notice
    >
      {{ composer.notice.value.text }}
      <template #action>
        <BaseButton
          v-if="composer.notice.value.tone === 'conflict'"
          size="sm"
          variant="quiet"
          data-composer-reload
          @click="composer.reload()"
          >Reload</BaseButton
        >
        <BaseButton v-else size="sm" variant="quiet" @click="composer.dismiss()"
          >Dismiss</BaseButton
        >
      </template>
    </FormNotice>
    <FormNotice v-if="owned.whole.length > 0" data-view-errors>
      <span v-for="(e, i) in owned.whole" :key="i" class="block">{{ e.message }}</span>
    </FormNotice>

    <div v-if="draft" class="flex flex-wrap items-start gap-x-10 gap-y-8">
      <div class="flex min-w-[min(100%,300px)] flex-[1_1_340px] flex-col gap-6">
        <section aria-labelledby="composer-outline" class="flex flex-col gap-2">
          <h3 id="composer-outline" class="m-0 text-body font-medium">Blocks</h3>
          <ul class="m-0 list-none p-0" data-composer-outline>
            <OutlineNode
              :block="draft"
              :index="0"
              :count="1"
              :selected="composer.selected.value"
              :problems="counts"
              :schema="schema"
              root
              @select="composer.selected.value = $event"
              @move="(id, by) => composer.move(id, by)"
              @remove="remove"
            />
          </ul>
          <div v-if="addTarget" class="flex flex-wrap items-end gap-2" data-composer-add>
            <div class="min-w-40 flex-[1_1_160px]">
              <BaseSelect
                v-model="addType"
                :label="`Add to ${BLOCK_LABELS[addTarget.type]}${addTarget.id === draft.id ? '' : ` ${addTarget.id}`}`"
                :options="addable"
              />
            </div>
            <BaseButton :disabled="!addType" data-composer-add-button @click="add"
              >Add block</BaseButton
            >
          </div>
        </section>

        <BlockForm
          v-if="selected"
          :key="selected.block.id"
          :block="selected.block"
          :root="draft"
          :path="selected.path"
          :schema="schema"
          :people="people"
          :errors="owned.byBlock.get(selected.block.id) ?? []"
        />

        <div class="flex flex-wrap gap-2 border-t border-line pt-4">
          <BaseButton
            variant="primary"
            :disabled="busy || !composer.dirty.value"
            data-composer-save
            @click="save"
            >{{ composer.busy.value === 'save' ? 'Saving…' : 'Save view' }}</BaseButton
          >
          <BaseButton :disabled="busy || !composer.dirty.value" @click="composer.discard()"
            >Discard changes</BaseButton
          >
          <BaseButton
            danger
            :disabled="busy || !saved?.stored"
            data-composer-reset
            @click="confirmReset = true"
            >Reset to default</BaseButton
          >
        </div>
      </div>

      <section
        aria-labelledby="composer-preview"
        class="flex min-w-[min(100%,340px)] flex-[2_1_480px] flex-col gap-3"
      >
        <h3 id="composer-preview" class="m-0 text-body font-medium">Preview</h3>
        <div class="rounded-card border border-line p-6">
          <ComposerPreview
            :draft="draft"
            :description="description"
            :folder-name="folder?.name ?? ''"
            :stored="composer.storedData.value"
            :unsaved="composer.unsaved.value"
            :problem="composer.previewProblem.value"
            :workspace-id="description.hub.workspaceId"
            :me="me"
            :people="people"
            @retry="composer.retryData()"
          />
        </div>
      </section>
    </div>
  </SettingsSection>

  <ConfirmDialog
    v-model:open="confirmReset"
    :title="`Reset ${folder?.name ?? 'this folder'} to its default view?`"
    message="The saved view is deleted and the folder opens on its default again. This cannot be undone."
    confirm-label="Reset to default"
    :busy="composer.busy.value === 'reset'"
    @confirm="reset"
  />
</template>
