<script setup lang="ts">
import { MAX_EXPAND_ATTRIBUTES, type Item, type ItemValues } from '@16bit/core'
import { ApiRequestError } from '../../api/client.ts'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSession } from '../../session/session.ts'
import ShellUser from '../../session/ShellUser.vue'
import { AppShell, BaseButton, FormNotice, ItemPanel } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import FolderSidebar from './FolderSidebar.vue'
import HubState from './HubState.vue'
import ItemDetails from './ItemDetails.vue'
import ItemPanelBody from './ItemPanelBody.vue'
import ItemsBlock from './ItemsBlock.vue'
import NewItemForm from './NewItemForm.vue'
import { provideValueContext } from './context.ts'
import { folderColumns, truncatedNote, useHub } from './useHub.ts'
import { useHubDirectory } from './useHubDirectory.ts'
import { canSort, inHub, useItems, valueErrors } from './useItems.ts'
import { usePrincipals } from './usePrincipals.ts'

const { workspaceId, hubId, folderId, itemId } = defineProps<{
  workspaceId: string
  hubId: string
  /** `null` shows the hub's own items. */
  folderId: string | null
  itemId: string | null
}>()

const router = useRouter()
const { hub, tree, readOnly: roleReadOnly, load: loadHub } = useHub(workspaceId, hubId)
const description = computed(() => (hub.value.state === 'ready' ? hub.value.data : null))
const items = useItems(workspaceId, () => description.value?.hub.idPrefix ?? '')
const { list, rows, notice } = items
// Read-only from the hub role on load, or after the server refused a write: a grant lowered
// while the page is open is only known once a write gets a 403.
const readOnly = computed(() => roleReadOnly.value || items.readOnly.value)

// Names for actors, and the hubs that linked items live in, for cells and editors.
const session = useSession()
const fetchFn: typeof fetch = (...args) => fetch(...args)
const directory = useHubDirectory(workspaceId, fetchFn)
const principals = usePrincipals(
  workspaceId,
  () => (session.me.value.state === 'ready' ? session.me.value.data : null),
  fetchFn,
)
watch(description, (d) => {
  if (d) directory.seed(d)
})
provideValueContext({
  workspaceId,
  fetchFn,
  actor: principals.actor,
  actorChoices: () => principals.choices.value,
  members: () => principals.status.value,
  retryMembers: () => void principals.load(),
  linkState: items.linkState,
  resolveLinked: items.resolveLinked,
  rememberLinked: items.rememberLinked,
  hub: directory.get,
  hubLookup: directory.lookup,
  ensureHubs: directory.ensure,
  retryHub: directory.retry,
  itemLink: (item) => ({
    name: 'hub',
    params: {
      workspaceId,
      hubId: item.hubId,
      ...(item.folderId === item.hubId ? {} : { folderId: item.folderId }),
    },
    query: { item: item.id },
  }),
})

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

// The server caps the hub description. Say so rather than show a partial list as complete.
const truncated = computed(() => (description.value ? truncatedNote(description.value) : ''))

const treeLoad = computed<Load<typeof tree.value>>(() =>
  hub.value.state === 'ready' ? { state: 'ready', data: tree.value } : hub.value,
)

onMounted(() => {
  void session.ensure()
  void principals.load()
})

// "New item" opens a form in the panel. On submit the row appears at once (see useItems).
const creating = ref(false)
const createBusy = ref(false)
const createErrors = ref<Record<string, string>>({})

// The folder's query expands its relation columns (at most MAX_EXPAND_ATTRIBUTES), so the
// table can show linked items, or "no access", without a request per row.
async function openFolder(id: string) {
  if (hub.value.state !== 'ready') await loadHub()
  if (id !== openFolderId.value) return
  const d = description.value
  const shown = d ? folderColumns(d, id).map((c) => c.attribute) : []
  const expand = shown
    .filter((a) => a.type === 'relation')
    .slice(0, MAX_EXPAND_ATTRIBUTES)
    .map((a) => a.id)
  // A kept sort on a column that can no longer be sorted is dropped instead of sent again.
  const sortable = d ? shown.filter(canSort).map((a) => a.id) : undefined
  await items.openFolder(id, expand, sortable)
}
async function retryHub() {
  await loadHub()
  void openFolder(openFolderId.value)
}
watch(
  openFolderId,
  (id) => {
    creating.value = false
    void openFolder(id)
  },
  { immediate: true },
)

// The item panel follows `?item=`. An item from another hub is treated as missing here.
const selected = ref<Load<string> | null>(null)
async function loadSelected(id: string | null) {
  if (!id) {
    selected.value = null
    return
  }
  selected.value = { state: 'loading' }
  const result = inHub(await items.openItem(id), hubId)
  if (id !== itemId) return
  selected.value = result.state === 'ready' ? { state: 'ready', data: id } : result
}
watch(
  () => itemId,
  (id) => {
    creating.value = false
    void loadSelected(id)
  },
  { immediate: true },
)
const retryPanel = () => void loadSelected(itemId)

const panelItem = computed<Load<Item> | null>(() => {
  const s = selected.value
  if (s?.state !== 'ready') return s
  const item = items.view(s.data)
  return item
    ? { state: 'ready', data: item }
    : { state: 'error', error: new ApiRequestError('not_found', 'This item is gone.', 404) }
})
const selectedItem = computed(() =>
  panelItem.value?.state === 'ready' ? panelItem.value.data : undefined,
)

const itemLink = (item: Item) => ({ query: { item: item.id } })
const openItem = (item: Item) => void router.push(itemLink(item))
const closePanel = () => {
  creating.value = false
  void router.push({ query: {} })
}

function startCreate() {
  if (readOnly.value) return
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
  } else if (readOnly.value) {
    // The hub refused the write: the form cannot succeed, the notice says why.
    creating.value = false
  } else {
    createErrors.value = valueErrors(result.error)
  }
}
</script>

<template>
  <AppShell>
    <template #actions><ShellUser /></template>
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
        <HubState
          :workspace-id="workspaceId"
          :hub-id="hubId"
          :hub="hub"
          :folder-found="folder !== null"
          @retry="retryHub()"
        >
          <template v-if="folder && hub.state === 'ready'">
            <div class="flex flex-wrap items-end justify-between gap-3">
              <div class="flex min-w-0 flex-col gap-1">
                <h1 class="m-0 font-display text-page-title font-medium tracking-[-0.01em]">
                  {{ folder.name }}
                </h1>
                <span v-if="countLine" class="text-ink2" data-count>{{ countLine }}</span>
                <span v-if="truncated" class="text-secondary text-ink3" data-truncated>{{
                  truncated
                }}</span>
              </div>
              <span v-if="readOnly" class="text-secondary text-ink3" data-read-only
                >You can view the items in this hub but not add or change them.</span
              >
              <BaseButton
                v-else
                variant="primary"
                :disabled="list.state !== 'ready'"
                data-new-item-button
                @click="startCreate"
                >New item</BaseButton
              >
            </div>

            <FormNotice v-if="notice" data-notice>
              {{ notice }}
              <template #action>
                <BaseButton size="sm" variant="quiet" @click="items.dismissNotice()"
                  >Dismiss</BaseButton
                >
              </template>
            </FormNotice>

            <ItemsBlock
              :folder-name="folder.name"
              :list="list"
              :rows="rows"
              :columns="columns"
              :id-prefix="hub.data.hub.idPrefix"
              :selected-id="itemId"
              :item-link="itemLink"
              :is-creating="items.isCreating"
              :read-only="readOnly"
              :sort="items.sort.value"
              @open="openItem"
              @retry="openFolder(openFolderId)"
              @more="items.loadMore()"
              @create="startCreate"
              @sort="items.setSort($event)"
            />
          </template>
        </HubState>
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
        v-else-if="itemId && panelItem"
        :title="selectedItem && description ? items.label(selectedItem) : 'Item'"
        class="flex-[1_1_320px]"
        @close="closePanel"
      >
        <ItemPanelBody :item="panelItem" @retry="retryPanel">
          <template #default="{ item }">
            <ItemDetails
              :key="item.id"
              :item="item"
              :columns="description ? folderColumns(description, item.folderId) : []"
              :saving="items.isSaving(item.id)"
              :disabled="items.isCreating(item.id)"
              :read-only="readOnly"
              @save="items.save(item.id, $event)"
            />
          </template>
        </ItemPanelBody>
      </ItemPanel>
    </div>
  </AppShell>
</template>
