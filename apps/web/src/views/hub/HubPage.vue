<script setup lang="ts">
import type { Item, ItemValues } from '@16bit/core'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { AppShell, BaseButton, ItemPanel, StateBlock } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import FolderSidebar from './FolderSidebar.vue'
import ItemDetails from './ItemDetails.vue'
import ItemsBlock from './ItemsBlock.vue'
import NewItemForm from './NewItemForm.vue'
import { folderColumns, useHub } from './useHub.ts'
import { useItems, valueErrors } from './useItems.ts'

const { workspaceId, hubId, folderId, itemId } = defineProps<{
  workspaceId: string
  hubId: string
  /** `null` shows the hub's own items. */
  folderId: string | null
  itemId: string | null
}>()

const router = useRouter()
const { hub, tree, load: loadHub } = useHub(workspaceId, hubId)
const description = computed(() => (hub.value.state === 'ready' ? hub.value.data : null))
const items = useItems(workspaceId, () => description.value?.hub.idPrefix ?? '')
const { list, rows, notice } = items

const openFolderId = computed(() => folderId ?? hubId)
const folder = computed(() => {
  const d = description.value
  if (!d) return null
  return d.hub.id === openFolderId.value
    ? d.hub
    : (d.folders.find((f) => f.id === openFolderId.value) ?? null)
})
const columns = computed(() =>
  description.value ? folderColumns(description.value, openFolderId.value) : [],
)

// The hub's own count includes every folder, so it is only shown when the hub has no folders.
const countLine = computed(() => {
  const f = folder.value
  const d = description.value
  if (!f || !d || (f.id === d.hub.id && d.folders.length > 0)) return ''
  return `${new Intl.NumberFormat('en').format(f.itemCount)} ${f.itemCount === 1 ? 'item' : 'items'}`
})

const treeLoad = computed<Load<typeof tree.value>>(() =>
  hub.value.state === 'ready' ? { state: 'ready', data: tree.value } : hub.value,
)

onMounted(() => {
  void loadHub()
})

// "New item" opens a form in the panel. On submit the row appears at once (see useItems).
const creating = ref(false)
const createBusy = ref(false)
const createErrors = ref<Record<string, string>>({})

watch(
  openFolderId,
  (id) => {
    creating.value = false
    void items.openFolder(id)
  },
  { immediate: true },
)

// The item panel follows `?item=`.
const selected = ref<Load<string> | null>(null)
watch(
  () => itemId,
  async (id) => {
    if (!id) {
      selected.value = null
      return
    }
    creating.value = false
    selected.value = { state: 'loading' }
    const result = await items.openItem(id)
    if (id !== itemId) return
    selected.value = result.state === 'ready' ? { state: 'ready', data: id } : result
  },
  { immediate: true },
)
const selectedItem = computed(() =>
  selected.value?.state === 'ready' ? items.view(selected.value.data) : undefined,
)

const itemLink = (item: Item) => ({ query: { item: item.id } })
const openItem = (item: Item) => void router.push(itemLink(item))
const closePanel = () => {
  creating.value = false
  void router.push({ query: {} })
}

function startCreate() {
  createErrors.value = {}
  creating.value = true
  if (itemId) void router.push({ query: {} })
}
async function submitCreate(values: ItemValues) {
  createBusy.value = true
  const result = await items.create(values)
  createBusy.value = false
  if (result.ok) {
    creating.value = false
    void router.push(itemLink(result.item))
  } else {
    createErrors.value = valueErrors(result.error)
  }
}

const retryPanel = () => {
  if (itemId) {
    selected.value = { state: 'loading' }
    void items.openItem(itemId).then((r) => {
      selected.value = r.state === 'ready' ? { state: 'ready', data: r.data.id } : r
    })
  }
}
</script>

<template>
  <AppShell>
    <template #sidebar>
      <FolderSidebar
        :workspace-id="workspaceId"
        :hub-name="description?.hub.name ?? null"
        :tree="treeLoad"
        :folder-id="openFolderId"
      />
    </template>

    <div class="flex flex-1 flex-wrap items-stretch">
      <main class="box-border flex min-w-0 flex-[999_1_420px] flex-col gap-6 px-4 py-6 sm:px-7">
        <StateBlock v-if="hub.state === 'loading'" state="loading" title="Loading hub" :rows="6" />
        <StateBlock
          v-else-if="
            hub.state === 'error' && (hub.error.isNoPermission || hub.error.status === 404)
          "
          state="no-permission"
          title="This hub is not available"
          message="It may not exist, or it may not be shared with you."
        >
          <template #action>
            <RouterLink to="/" class="text-accent">Back to workspaces</RouterLink>
          </template>
        </StateBlock>
        <StateBlock
          v-else-if="hub.state === 'error'"
          state="error"
          title="The hub could not be loaded"
          :message="hub.error.message"
        >
          <template #action>
            <BaseButton size="sm" @click="loadHub()">Try again</BaseButton>
          </template>
        </StateBlock>
        <StateBlock
          v-else-if="!folder"
          state="empty"
          title="This folder is not in this hub"
          message="It may have been moved or deleted."
        >
          <template #action>
            <RouterLink :to="{ name: 'hub', params: { workspaceId, hubId } }" class="text-accent"
              >Open {{ hub.data.hub.name }}</RouterLink
            >
          </template>
        </StateBlock>
        <template v-else>
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div class="flex min-w-0 flex-col gap-1">
              <h1 class="m-0 font-display text-page-title font-medium tracking-[-0.01em]">
                {{ folder.name }}
              </h1>
              <span v-if="countLine" class="text-ink2" data-count>{{ countLine }}</span>
            </div>
            <BaseButton
              variant="primary"
              :disabled="list.state !== 'ready'"
              data-new-item-button
              @click="startCreate"
              >New item</BaseButton
            >
          </div>

          <div
            v-if="notice"
            role="alert"
            class="flex flex-wrap items-center justify-between gap-2 rounded-control border border-danger px-3 py-2 text-danger"
            data-notice
          >
            <span class="min-w-0">{{ notice }}</span>
            <BaseButton size="sm" variant="quiet" @click="items.dismissNotice()"
              >Dismiss</BaseButton
            >
          </div>

          <ItemsBlock
            :folder-name="folder.name"
            :list="list"
            :rows="rows"
            :columns="columns"
            :id-prefix="hub.data.hub.idPrefix"
            :selected-id="itemId"
            :item-link="itemLink"
            :is-creating="items.isCreating"
            @open="openItem"
            @retry="items.openFolder(openFolderId)"
            @more="items.loadMore()"
            @create="startCreate"
          />
        </template>
      </main>

      <ItemPanel
        v-if="creating && folder"
        title="New item"
        label="New item"
        class="flex-[1_1_320px]"
        @close="closePanel"
      >
        <NewItemForm
          :columns="columns"
          :busy="createBusy"
          :server-errors="createErrors"
          @submit="submitCreate"
          @cancel="closePanel"
        />
      </ItemPanel>
      <ItemPanel
        v-else-if="itemId && selected"
        :title="selectedItem && description ? items.label(selectedItem) : 'Item'"
        class="flex-[1_1_320px]"
        @close="closePanel"
      >
        <StateBlock v-if="selected.state === 'loading'" state="loading" title="Loading item" />
        <StateBlock
          v-else-if="selected.state === 'error' && selected.error.isNoPermission"
          state="no-permission"
          title="You do not have access to this item"
        />
        <StateBlock
          v-else-if="selected.state === 'error' && selected.error.status === 404"
          state="empty"
          title="This item does not exist"
          message="It may have been deleted."
        />
        <StateBlock
          v-else-if="selected.state === 'error'"
          state="error"
          title="The item could not be loaded"
          :message="selected.error.message"
        >
          <template #action>
            <BaseButton size="sm" @click="retryPanel">Try again</BaseButton>
          </template>
        </StateBlock>
        <ItemDetails
          v-else-if="selectedItem"
          :key="selectedItem.id"
          :item="selectedItem"
          :columns="description ? folderColumns(description, selectedItem.folderId) : []"
          :saving="items.isSaving(selectedItem.id)"
          @save="items.save(selectedItem.id, $event)"
        />
      </ItemPanel>
    </div>
  </AppShell>
</template>
