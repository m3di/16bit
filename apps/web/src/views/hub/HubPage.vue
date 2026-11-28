<script setup lang="ts">
import {
  MAX_EXPAND_ATTRIBUTES,
  type Block,
  type Folder,
  type HubDescription,
  type Item,
  type ItemValues,
} from '@16bit/core'
import { ApiRequestError } from '../../api/client.ts'
import { computed, nextTick, onMounted, ref, toRaw, useTemplateRef, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useSession } from '../../session/session.ts'
import FolderActions from '../hub-settings/FolderActions.vue'
import { canManageSchema, sidebarActions, type SidebarActionKey } from '../hub-settings/schema.ts'
import { useHubSettings } from '../hub-settings/useHubSettings.ts'
import { viewerOf } from '../hub-settings/access.ts'
import ShellUser from '../../session/ShellUser.vue'
import ConnectionStatus from '../../sync/ConnectionStatus.vue'
import { useLiveHub } from '../../sync/live.ts'
import {
  AppShell,
  BaseButton,
  FormNotice,
  ItemPanel,
  NoViewYet,
  PageHeader,
  StateBlock,
} from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import FolderSidebar from './FolderSidebar.vue'
import HubState from './HubState.vue'
import ItemDetails from './ItemDetails.vue'
import ItemPanelBody from './ItemPanelBody.vue'
import ItemsBlock from './ItemsBlock.vue'
import NewItemForm from './NewItemForm.vue'
import { provideValueContext } from './context.ts'
import { folderItemsOpener } from './folderItems.ts'
import { folderColumns, ownItemCount, truncatedNote, useHub } from './useHub.ts'
import { useHubDirectory } from './useHubDirectory.ts'
import { opensHubSettings } from '../home/hubSettings.ts'
import { canWriteItems } from './newItem.ts'
import { canSort, inHub, useItems, valueErrors } from './useItems.ts'
import { usePrincipals } from './usePrincipals.ts'
import { httpViewSource, useViewSource } from '../root-view/source.ts'
import { useRootView } from '../root-view/useRootView.ts'
import ViewRenderer from '../root-view/ViewRenderer.vue'
import { provideViewHost } from '../root-view/host.ts'

const { workspaceId, hubId, folderId, itemId } = defineProps<{
  workspaceId: string
  hubId: string
  /** `null` shows the hub's own items. */
  folderId: string | null
  itemId: string | null
}>()

const router = useRouter()
const { hub: hubRead, tree, load: loadHub, refresh: refreshHub } = useHub(workspaceId, hubId)
const items = useItems(workspaceId, () => description.value?.hub.idPrefix ?? '', undefined, {
  hubId: () => hubId,
})
// Feed events about this hub (D58): a schema change is read again in place, and a lost grant
// shows the no-permission state instead of rows that no longer update. Item changes read the
// hub again too, for the sidebar's folder counts.
const live = useLiveHub(
  items.store,
  () => hubId,
  () => void refreshHub(),
  () => refreshHub(),
)
const hub = computed<Load<HubDescription>>(() =>
  live.lost.value
    ? {
        state: 'error',
        error: new ApiRequestError('forbidden', 'You no longer have access to this hub.', 403),
      }
    : hubRead.value,
)
const description = computed(() => (hub.value.state === 'ready' ? hub.value.data : null))
const { list, notice } = items
const session = useSession()

// `item.write` from `can()`, once both the reader and their hub role are known.
const writeAccess = computed(() =>
  canWriteItems(
    session.me.value.state === 'ready' ? session.me.value.data : undefined,
    workspaceId,
    description.value?.hubRole,
  ),
)
// Read-only by role, or after the server refused a write: a grant lowered while the page is
// open is only known once a write gets a 403.
const readOnly = computed(() => writeAccess.value === false || items.readOnly.value)
// "New item" waits until the reader is known to be allowed. Edits in the panel only turn
// read-only once the role is known to refuse them, so fields do not flash a read-only hint.
const canWrite = computed(() => writeAccess.value === true && !items.readOnly.value)

// Names for actors, and the hubs that linked items live in, for cells and editors.
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
      ...(item.folderId === item.hubId && !opensElsewhere(item.hubId)
        ? {}
        : { folderId: item.folderId }),
    },
    query: { item: item.id },
  }),
})

const managesSchema = computed(() => {
  const d = description.value
  const me = session.me.value
  return !!d && me.state === 'ready' && canManageSchema(me.data, workspaceId, d.hubRole)
})
// The sidebar's folder menus, as in Hub settings → Folders, for those who may change the schema.
// Writes go through the settings model, on a copy of this page's description; after one the page
// reads the hub again, so the sidebar and the open folder show the change without a reload.
const schema = useHubSettings(workspaceId, hubId)
watch(
  description,
  (d) => {
    schema.hub.value = d
      ? { state: 'ready', data: structuredClone(toRaw(d)) }
      : { state: 'loading' }
  },
  { immediate: true },
)
const schemaDescription = computed(() =>
  schema.hub.value.state === 'ready' ? schema.hub.value.data : null,
)
// The root's menu also leads to the hub's settings, for those who see the Hub settings link.
const folderMenus = computed(() => {
  const d = schemaDescription.value
  const reader = { managesSchema: managesSchema.value, opensSettings: opensSettings.value }
  if (!d || (!reader.managesSchema && !reader.opensSettings)) return undefined
  return (f: Folder) => sidebarActions(d, f, reader)
})
const folderActionsRef = useTemplateRef<InstanceType<typeof FolderActions>>('folderActionsDialogs')
function onFolderAction(f: Folder, key: SidebarActionKey) {
  if (key === 'settings') {
    void router.push({ name: 'hub-settings-general', params: { workspaceId, hubId } })
    return
  }
  folderActionsRef.value?.run(f, key)
}
function onFolderChanged(deleted: Folder | null) {
  void refreshHub()
  // The open folder is gone: show the hub's own items instead.
  if (deleted?.id === openFolderId.value) {
    void router.push({ name: 'hub', params: { workspaceId, hubId } })
  }
}
// What the last folder action did. Focused after a delete, since the row that had focus is gone.
const sidebarStatus = ref('')
const sidebarStatusEl = useTemplateRef<HTMLElement>('sidebarStatusEl')
async function onSidebarStatus(text: string, focus: boolean) {
  sidebarStatus.value = text
  if (!focus) return
  await nextTick()
  sidebarStatusEl.value?.focus()
}

// The same rule as the dashboard's settings gear (docs/ROLES.md).
const opensSettings = computed(() => {
  const me = session.me.value
  const viewer = me.state === 'ready' ? viewerOf(me.data, workspaceId) : null
  return opensHubSettings(viewer, description.value?.hubRole ?? null)
})

// Without a folder in the route the hub opens on its "Opens on" folder (D76), or its root. Until
// the hub is read that is not known, and nothing is shown for it yet.
const openFolderId = computed(() => {
  if (folderId) return folderId
  const d = description.value
  const opensOn = d?.hub.opensOnFolderId
  return opensOn && d.folders.some((f) => f.id === opensOn) ? opensOn : hubId
})
// Links to the hub root name it when the hub opens elsewhere.
const opensElsewhere = (id: string) =>
  id === hubId && description.value?.hub.opensOnFolderId !== undefined

const folder = computed(() => {
  const d = description.value
  if (!d) return null
  return d.hub.id === openFolderId.value
    ? d.hub
    : (d.folders.find((f) => f.id === openFolderId.value) ?? null)
})
// The open folder's root view (D76): today's folder screen when it has none stored, "No view
// yet" for a views-only folder with none, else the view, read from the view routes.
const viewSource = useViewSource(() => httpViewSource(workspaceId, fetchFn))
const rootView = useRootView({
  source: viewSource,
  store: items.store,
  hubId: () => hubId,
  folderId: () => (description.value && folder.value ? openFolderId.value : null),
  description: () => description.value,
  onLinked: (item) => {
    items.rememberLinked(item)
  },
})
const viewMode = rootView.mode
// "Compose" on "No view yet" for hub admins only (D78): the composer on this folder.
const composeTo = computed(() =>
  managesSchema.value
    ? {
        name: 'hub-settings-views',
        params: { workspaceId, hubId },
        query: { folder: openFolderId.value },
      }
    : null,
)
// A root view shows the live dot in its header instead of ConnectionStatus, never both.
const headerShowsLive = computed(() => viewMode.value === 'view' || viewMode.value === 'none')
const liveStatus = computed(() => {
  const status = items.store.status.value
  return status === 'idle' ? null : status
})
// What a view's data blocks read from this page (M3 store, panel, "New item").
provideViewHost({
  description: () => description.value,
  current: (item) => {
    const store = items.store
    if (store.isDeleted(item.id)) return undefined
    // Hidden while a delete of the reader's own is on its way.
    return store.view(item.id) ?? (store.get(item.id) ? undefined : item)
  },
  itemLink: (item) => ({ query: { item: item.id } }),
  canCreate: (id) => {
    const d = description.value
    const f = d?.hub.id === id ? d.hub : d?.folders.find((x) => x.id === id)
    return canWrite.value && !!f && !f.viewsOnly
  },
  create: (id, values) => {
    startCreate({ folderId: id, values })
  },
  me: () => principals.self.value?.id ?? null,
})
const nameOfBlock = (block: Block) => {
  const config = block.config as { label?: string; binding?: { folderId?: string } }
  if (config.label) return config.label
  const id = config.binding?.folderId
  const d = description.value
  const f = d && id ? (d.hub.id === id ? d.hub : d.folders.find((x) => x.id === id)) : undefined
  return f?.name ?? 'Items'
}
const columns = computed(() =>
  description.value ? folderColumns(description.value, openFolderId.value) : [],
)

// The items directly in the open folder; for the hub, its total less its folders'.
const countLine = computed(() => {
  const f = folder.value
  const d = description.value
  const count = f && d ? ownItemCount(d, f) : null
  if (count === null) return ''
  return `${new Intl.NumberFormat('en').format(count)} ${count === 1 ? 'item' : 'items'}`
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
  if (hubRead.value.state !== 'ready') await loadHub()
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
// Once the hub is read again, the watch below opens the folder.
const retryHub = () => void loadHub()
void loadHub()
// Only today's folder screen lists the folder's items here; a root view reads its own data. The
// items are read while the view loads, so a folder with no stored view waits for no extra request.
const openItems = folderItemsOpener(
  (id) => void openFolder(id),
  (id) => {
    const f = folder.value
    return f?.id === id && f.viewsOnly !== true && !rootView.knownStored(id)
  },
)
watch(openFolderId, () => {
  creating.value = false
})
watch(
  [openFolderId, viewMode, folder],
  ([id, mode]) => {
    openItems(id, mode)
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
// A click opens the panel with focus on it; the arrow keys in the table keep focus there, so
// the reader can go on through the rows (DESIGN.md, virtual rows).
const panelKeepsFocus = ref(false)
const openItem = (item: Item, via: 'pointer' | 'keyboard' = 'pointer') => {
  panelKeepsFocus.value = via === 'keyboard'
  void router.push(itemLink(item))
}
const closePanel = () => {
  creating.value = false
  void router.push({ query: {} })
}

// Where "New item" creates: the open folder, or a view block's binding folder with its presets
// filled in (D77).
const createIn = ref<{ folderId: string; values: ItemValues }>({ folderId: '', values: {} })
const createColumns = computed(() =>
  description.value ? folderColumns(description.value, createIn.value.folderId) : [],
)
function startCreate(target: { folderId: string; values: ItemValues } | null = null) {
  if (!canWrite.value) return
  createIn.value = target ?? { folderId: openFolderId.value, values: {} }
  createErrors.value = {}
  creating.value = true
  if (itemId) void router.push({ query: {} })
}
async function submitCreate(values: ItemValues) {
  createBusy.value = true
  const target = createIn.value.folderId
  const result = await items.create(values, target === openFolderId.value ? undefined : target)
  createBusy.value = false
  if (result.ok) {
    creating.value = false
    if (viewMode.value === 'view') {
      // From a view, the new item opens in the panel and the page stays; its block reads again
      // when the feed brings the create.
      void router.push({ query: { item: result.item.id } })
    } else {
      // The new item opens on its own page, where the rest of it can be filled in.
      void router.push({ name: 'item', params: { workspaceId, itemId: result.item.id } })
    }
  } else if (readOnly.value) {
    // The hub refused the write: the form cannot succeed, the notice says why.
    creating.value = false
  } else {
    createErrors.value = valueErrors(result.error)
  }
}
</script>

<template>
  <AppShell panes>
    <template #actions>
      <!-- Hub admins, owners and admins manage the hub in its settings. -->
      <RouterLink
        v-if="opensSettings"
        :to="{ name: 'hub-settings-general', params: { workspaceId, hubId } }"
        class="border-b border-line2 text-secondary text-ink no-underline hover:border-line3"
        data-hub-settings-link
        >Hub settings</RouterLink
      >
      <ConnectionStatus v-if="!headerShowsLive" :status="items.store.status.value" />
      <ShellUser />
    </template>
    <template #sidebar>
      <FolderSidebar
        :workspace-id="workspaceId"
        :hub-name="description?.hub.name ?? null"
        :tree="treeLoad"
        :opens-on-folder-id="description?.hub.opensOnFolderId"
        :folder-id="openFolderId"
        :actions-for="folderMenus"
        @action="onFolderAction"
      />
      <p
        ref="sidebarStatusEl"
        tabindex="-1"
        role="status"
        class="m-0 px-2 pt-2 text-secondary text-ink2 outline-none empty:hidden"
        data-sidebar-status
      >
        {{ sidebarStatus }}
      </p>
      <FolderActions
        v-if="schemaDescription && managesSchema"
        ref="folderActionsDialogs"
        :description="schemaDescription"
        :model="schema"
        @status="onSidebarStatus"
        @changed="onFolderChanged"
      />
    </template>

    <div class="flex flex-1 items-stretch md:min-h-0">
      <main
        class="box-border flex min-w-0 flex-[999_1_420px] flex-col gap-6 px-4 py-6 sm:px-7 md:min-h-0 md:overflow-y-auto"
        data-main-pane
      >
        <HubState
          :workspace-id="workspaceId"
          :hub-id="hubId"
          :hub="hub"
          :folder-found="folder !== null"
          @retry="retryHub()"
        >
          <StateBlock
            v-if="folder && viewMode === 'loading'"
            state="loading"
            :title="`Loading ${folder.name}`"
            :rows="6"
          />
          <StateBlock
            v-else-if="folder && viewMode === 'error' && rootView.viewError.value?.isNoPermission"
            state="no-permission"
            title="You do not have access to this folder's view"
          />
          <StateBlock
            v-else-if="folder && viewMode === 'error' && rootView.viewError.value?.isNotFound"
            state="not-found"
            title="This folder's view is not available"
            message="It may not exist, or it may not be shared with you."
          />
          <StateBlock
            v-else-if="folder && viewMode === 'error'"
            state="error"
            title="This view could not be loaded"
            :message="rootView.viewError.value?.message ?? ''"
          >
            <template #action>
              <BaseButton size="sm" @click="rootView.reload()">Try again</BaseButton>
            </template>
          </StateBlock>
          <template v-else-if="folder && viewMode === 'none'">
            <PageHeader :title="folder.name" :live="liveStatus" />
            <NoViewYet :compose-to="composeTo" />
          </template>
          <template v-else-if="folder && viewMode === 'view'">
            <FormNotice v-if="notice" data-notice>
              {{ notice }}
              <template #action>
                <BaseButton size="sm" variant="quiet" @click="items.dismissNotice()"
                  >Dismiss</BaseButton
                >
              </template>
            </FormNotice>
            <ViewRenderer
              :page="rootView.rendered.value?.page ?? null"
              :folder-name="folder.name"
              :live="liveStatus"
              :blocks="rootView.blocks.value"
              :problem="rootView.problem.value"
              :name-of="nameOfBlock"
              @retry="rootView.retry()"
            />
          </template>
          <template v-else-if="folder && hub.state === 'ready'">
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
                v-else-if="canWrite"
                variant="primary"
                :disabled="list.state !== 'ready'"
                data-new-item-button
                @click="startCreate()"
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
              :row-at="items.rowAt"
              :index-of="items.indexOf"
              :reordered="items.reordered.value"
              :columns="columns"
              :id-prefix="hub.data.hub.idPrefix"
              :selected-id="itemId"
              :item-link="itemLink"
              :is-creating="items.isCreating"
              :read-only="!canWrite"
              :sort="items.sort.value"
              @open="openItem"
              @retry="openFolder(openFolderId)"
              @windows="items.showWindows($event)"
              @retry-windows="items.retryWindows()"
              @create="startCreate()"
              @sort="items.setSort($event)"
            />
          </template>
        </HubState>
      </main>

      <ItemPanel
        v-if="creating && folder && !live.lost.value"
        title="New item"
        label="New item"
        class="flex-[1_1_320px]"
        @close="closePanel"
      >
        <NewItemForm
          :key="createIn.folderId + JSON.stringify(createIn.values)"
          :columns="createColumns"
          :initial="createIn.values"
          :busy="createBusy"
          :server-errors="createErrors"
          @submit="submitCreate"
          @cancel="closePanel"
        />
      </ItemPanel>
      <ItemPanel
        v-else-if="itemId && panelItem && !live.lost.value"
        :title="selectedItem && description ? items.label(selectedItem) : 'Item'"
        :keep-focus="panelKeepsFocus"
        class="flex-[1_1_320px]"
        @close="closePanel"
      >
        <ItemPanelBody :item="panelItem" @retry="retryPanel">
          <template #default="{ item }">
            <RouterLink
              v-if="!items.isCreating(item.id)"
              :to="{ name: 'item', params: { workspaceId, itemId: item.id } }"
              class="self-start border-b border-line2 text-ink no-underline hover:border-line3"
              data-item-page-link
              >Open page</RouterLink
            >
            <ItemDetails
              :key="item.id"
              :item="item"
              :columns="description ? folderColumns(description, item.folderId) : []"
              :saving="items.isSaving(item.id)"
              :disabled="items.isCreating(item.id)"
              :read-only="readOnly"
              :refused-value="(attributeId: string) => items.refusedValue(item.id, attributeId)"
              :saving-field="(attributeId: string) => items.savingField(item.id, attributeId)"
              @save="(values, basedOn) => items.save(item.id, values, basedOn)"
              @dismiss-refused="items.forgetRefused(item.id, [$event])"
            />
          </template>
        </ItemPanelBody>
      </ItemPanel>
    </div>
  </AppShell>
</template>
