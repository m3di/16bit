<script setup lang="ts">
import type { Item, RelationConfig } from '@16bit/core'
import { computed, ref, useId, watch } from 'vue'
import { BaseButton, BaseInput, BaseSelect, StateBlock } from '../../ui/index.ts'
import { useValueContext } from './context.ts'
import { displayId, itemTitle, toggled } from './relations.ts'
import RelationValue from './RelationValue.vue'
import { folderColumns, folderTree } from './useHub.ts'
import { useRelationSearch } from './useRelationSearch.ts'

const {
  config,
  value,
  label,
  error = '',
  disabled,
  readOnly,
  itemId = null,
} = defineProps<{
  config: RelationConfig
  value: readonly string[]
  label: string
  error?: string
  disabled?: boolean
  readOnly?: boolean
  /** The item being edited, which is not offered as a link to itself. */
  itemId?: string | null
}>()

const emit = defineEmits<{ commit: [value: string[] | null] }>()

const ctx = useValueContext()
const id = useId()
const errorId = `${id}-error`
const pickerId = `${id}-picker`

const open = ref(false)
const target = computed(() => ctx.hub(config.targetHubId))
const targetHub = computed(() => (target.value.state === 'ready' ? target.value.data : null))
const search = useRelationSearch(ctx.workspaceId, () => targetHub.value, ctx.fetchFn)

const full = computed(() => !config.multiple && value.length > 0)

function toggle() {
  open.value = !open.value
  if (!open.value) return
  ctx.ensureHubs([config.targetHubId])
  if (targetHub.value && !search.results.value) void search.search()
}
// The first search waits for the target hub's description.
watch(targetHub, (hub) => {
  if (hub && open.value && !search.results.value) void search.search()
})

const folders = computed(() =>
  targetHub.value
    ? folderTree(targetHub.value).map(({ folder, depth }) => ({
        value: folder.id,
        label: `${'– '.repeat(depth)}${folder.name}`,
      }))
    : [],
)
const folderModel = computed({
  get: () => search.folder.value ?? '',
  set: (v: string) => {
    search.setFolder(v)
  },
})

const offered = computed(() => search.offered(itemId ? [...value, itemId] : value))
const result = (item: Item) => {
  const hub = targetHub.value
  return hub
    ? { id: displayId(hub, item), title: itemTitle(item, folderColumns(hub, item.folderId)) }
    : { id: '', title: '' }
}

function link(item: Item) {
  ctx.rememberLinked(item)
  emit('commit', toggled(value, item.id, true, config.multiple))
  if (!config.multiple) open.value = false
}
function remove(item: string) {
  emit('commit', toggled(value, item, false))
}
</script>

<template>
  <div
    role="group"
    :aria-labelledby="`${id}-label`"
    :aria-describedby="error ? errorId : undefined"
    class="flex min-w-0 flex-col gap-1"
  >
    <span :id="`${id}-label`" class="text-secondary text-ink3">{{ label }}</span>
    <RelationValue
      :ids="value"
      :label="label"
      :removable="!readOnly && !disabled"
      resolve
      @remove="remove"
    />
    <span v-if="readOnly" class="text-secondary text-ink3"
      >You can view this but not change it.</span
    >
    <div v-else class="flex flex-wrap gap-2">
      <BaseButton
        size="sm"
        :disabled="disabled"
        :aria-expanded="open ? 'true' : 'false'"
        :aria-controls="pickerId"
        data-link-toggle
        @click="toggle"
        >{{ open ? 'Close' : full ? 'Change link' : 'Link an item' }}</BaseButton
      >
    </div>
    <span v-if="error" :id="errorId" class="text-secondary text-danger">{{ error }}</span>

    <div
      v-if="open && !readOnly"
      :id="pickerId"
      class="flex flex-col gap-2 border-t border-line pt-2"
      data-relation-picker
    >
      <StateBlock
        v-if="target.state === 'loading'"
        state="loading"
        title="Loading items to link"
        :rows="2"
      />
      <StateBlock
        v-else-if="
          target.state === 'error' && (target.error.isNotFound || target.error.isNoPermission)
        "
        state="no-permission"
        title="You cannot see the items this field links to"
        message="Ask a hub admin for access to the hub it points to."
      />
      <StateBlock
        v-else-if="target.state === 'error'"
        state="error"
        title="Items to link could not be loaded"
        :message="target.error.message"
      >
        <template #action>
          <BaseButton size="sm" @click="ctx.retryHub(config.targetHubId)">Try again</BaseButton>
        </template>
      </StateBlock>
      <template v-else>
        <form
          class="flex flex-wrap items-end gap-2"
          role="search"
          @submit.prevent="search.search()"
        >
          <div v-if="folders.length > 1" class="min-w-0 flex-[1_1_140px]">
            <BaseSelect v-model="folderModel" label="Folder" :options="folders" />
          </div>
          <div class="min-w-0 flex-[2_1_180px]">
            <BaseInput
              v-model="search.text.value"
              type="search"
              :label="`Search ${targetHub?.hub.name ?? 'items'}`"
              data-link-search
            />
          </div>
          <BaseButton type="submit" size="md">Search</BaseButton>
        </form>

        <StateBlock
          v-if="!search.results.value || search.results.value.state === 'loading'"
          state="loading"
          title="Searching"
          :rows="3"
        />
        <StateBlock
          v-else-if="
            search.results.value.state === 'error' &&
            (search.results.value.error.isNotFound || search.results.value.error.isNoPermission)
          "
          state="no-permission"
          title="You cannot see the items in this folder"
        />
        <StateBlock
          v-else-if="search.results.value.state === 'error'"
          state="error"
          title="The search failed"
          :message="search.results.value.error.message"
        >
          <template #action>
            <BaseButton size="sm" @click="search.search()">Try again</BaseButton>
          </template>
        </StateBlock>
        <template v-else>
          <p
            v-if="search.local.value && search.searched.value"
            class="m-0 text-secondary text-ink3"
          >
            Matches among the items loaded so far. Load more to search further.
          </p>
          <StateBlock
            v-if="offered.length === 0 && !search.results.value.data.nextCursor"
            state="empty"
            :title="search.searched.value ? 'No items match' : 'No items to link here'"
          />
          <ul
            v-else
            class="m-0 flex max-h-80 list-none flex-col overflow-y-auto p-0"
            :aria-label="`Items to link to ${label}`"
          >
            <li v-for="item in offered" :key="item.id">
              <button
                type="button"
                class="flex min-h-8 w-full min-w-0 cursor-pointer items-baseline gap-1.5 rounded-control border-0 bg-transparent px-2 text-left text-ink hover:bg-selected"
                :data-link-item="item.id"
                @click="link(item)"
              >
                <span class="sr-only">Link </span>
                <span class="shrink-0 font-mono text-secondary text-ink3">{{
                  result(item).id
                }}</span>
                <span class="truncate">{{ result(item).title }}</span>
              </button>
            </li>
          </ul>
          <div class="flex flex-wrap items-center gap-2">
            <BaseButton
              v-if="search.results.value.data.nextCursor"
              size="sm"
              :disabled="search.results.value.data.more"
              @click="search.loadMore()"
              >{{ search.results.value.data.more ? 'Loading…' : 'Load more' }}</BaseButton
            >
            <span
              v-if="search.results.value.data.moreError"
              role="alert"
              class="text-secondary text-danger"
              >More items could not be loaded.
              {{ search.results.value.data.moreError.message }}</span
            >
          </div>
        </template>
      </template>
    </div>
  </div>
</template>
