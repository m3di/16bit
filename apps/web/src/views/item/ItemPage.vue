<script setup lang="ts">
import type { Item } from '@16bit/core'
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import ShellUser from '../../session/ShellUser.vue'
import ConnectionStatus from '../../sync/ConnectionStatus.vue'
import { useLiveHub } from '../../sync/live.ts'
import { useSession } from '../../session/session.ts'
import { AppShell, ConfirmDialog } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import { provideValueContext } from '../hub/context.ts'
import FolderSidebar from '../hub/FolderSidebar.vue'
import { displayId } from '../hub/relations.ts'
import { canWriteItems } from '../hub/newItem.ts'
import { folderColumns, folderTree } from '../hub/useHub.ts'
import { useHubDirectory } from '../hub/useHubDirectory.ts'
import { useItems } from '../hub/useItems.ts'
import { usePrincipals } from '../hub/usePrincipals.ts'
import ItemBody from './ItemBody.vue'
import ItemState from './ItemState.vue'
import {
  afterExpandRead,
  expandFor,
  folderLink,
  itemPageLink,
  malformedItemId,
  livePageState,
  pageState,
  type PageState,
} from './item-page.ts'
import { useBacklinks } from './useBacklinks.ts'
import { useHistory } from './useHistory.ts'

const { workspaceId, itemId } = defineProps<{ workspaceId: string; itemId: string }>()

const router = useRouter()
const session = useSession()
const fetchFn: typeof fetch = (...args) => fetch(...args)
const directory = useHubDirectory(workspaceId, fetchFn)

// The item's hub is only known once the item is read; its description comes from the directory.
const located = ref<Load<Item>>({ state: 'loading' })
const hubId = computed(() => (located.value.state === 'ready' ? located.value.data.hubId : null))
const hubLoad = computed(() => (hubId.value ? directory.get(hubId.value) : null))
const description = computed(() => (hubLoad.value?.state === 'ready' ? hubLoad.value.data : null))

const items = useItems(workspaceId, () => description.value?.hub.idPrefix ?? '', fetchFn, {
  list: false,
})
// Feed events about the item's hub (D58): a schema change is read again in place; a lost grant
// shows the no-permission state.
const live = useLiveHub(
  items.store,
  () => hubId.value,
  (id) => {
    directory.refresh(id)
  },
)
const principals = usePrincipals(
  workspaceId,
  () => (session.me.value.state === 'ready' ? session.me.value.data : null),
  fetchFn,
)
const backlinks = useBacklinks(workspaceId, itemId, fetchFn)
const history = useHistory(workspaceId, itemId, fetchFn)

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
  itemLink: (item) => itemPageLink(workspaceId, item),
})

// The item shows once its hub is known and its relations are expanded, so linked items come
// with it instead of one request each. If that read fails, the editors read them one by one.
const shown = ref(false)
async function locate() {
  shown.value = false
  located.value = { state: 'loading' }
  // An ID the API would refuse with a 400 can never load, so it is not found, not an error.
  const malformed = malformedItemId(itemId)
  if (malformed) {
    located.value = malformed
    return
  }
  const result = await items.openItem(itemId)
  located.value = result
  if (result.state === 'ready') directory.ensure([result.data.hubId])
}
watch(
  description,
  async (d) => {
    if (!d || shown.value || located.value.state !== 'ready') return
    const expand = expandFor(folderColumns(d, located.value.data.folderId))
    if (expand.length > 0) {
      // Deleted or hidden since the first read: show that, not the first copy as if live.
      located.value = afterExpandRead(located.value, await items.readItem(itemId, expand))
      if (located.value.state !== 'ready') return
    }
    shown.value = true
    void backlinks.load()
    void history.load()
  },
  { immediate: true },
)

const page = computed((): PageState => {
  const state = pageState(located.value, hubLoad.value)
  const loaded: PageState =
    state.state !== 'ready'
      ? state
      : !shown.value
        ? { state: 'loading' }
        : // While its own delete is pending the item is hidden from lists; the page keeps it.
          { ...state, item: items.view(itemId) ?? state.item }
  return livePageState(loaded, {
    lost: live.lost.value,
    deleted: items.store.isDeleted(itemId),
    deletingHere: deleting.value || leaving.value,
  })
})

function retry() {
  if (located.value.state === 'error') void locate()
  else if (hubId.value) directory.retry(hubId.value)
}

// `item.write` from `can()`. Read-only once the role is known to refuse, or after the server
// refused a write; not while the reader or the hub is still loading.
const readOnly = computed(
  () =>
    canWriteItems(
      session.me.value.state === 'ready' ? session.me.value.data : undefined,
      workspaceId,
      description.value?.hubRole,
    ) === false || items.readOnly.value,
)
const tree = computed(() =>
  description.value
    ? { state: 'ready' as const, data: folderTree(description.value) }
    : { state: 'loading' as const },
)

onMounted(() => {
  void session.ensure()
  void principals.load()
  void locate()
})

// Delete asks first. The item stays until the server agrees; a refusal shows in the dialog.
const confirming = ref(false)
const deleting = ref(false)
/** Deleted here: the page is on its way back to the folder, not showing "not available". */
const leaving = ref(false)
const deleteError = ref('')
function askDelete() {
  deleteError.value = ''
  confirming.value = true
}
async function confirmDelete() {
  if (page.value.state !== 'ready') return
  const item = page.value.item
  deleting.value = true
  deleteError.value = ''
  const result = await items.remove(itemId)
  leaving.value = result.ok
  deleting.value = false
  if (result.ok) {
    confirming.value = false
    void router.replace(folderLink(workspaceId, item))
  } else {
    deleteError.value = result.message
  }
}
// After a refused delete the page turns read-only and the Delete button that opened the dialog
// is gone, so focus would drop to the page when the dialog closes. It goes to the note instead.
const body = useTemplateRef<InstanceType<typeof ItemBody>>('body')
function dialogClosed() {
  if (readOnly.value) body.value?.focusReadOnly()
}
const deleteLabel = computed(() =>
  page.value.state === 'ready' ? displayId(page.value.hub, page.value.item) : 'this item',
)

// A newer version than the history holds (an edit here, or one from the feed): read the new
// entries. Pending edits do not count, since the server has not written them yet. Declared
// last: `page` reads refs declared above, so the watcher cannot run before them.
watch(
  () => (page.value.state === 'ready' ? page.value.item.version : null),
  (version) => {
    const newest = history.newestVersion()
    if (version !== null && newest !== null && version > newest) void history.refresh()
  },
)
</script>

<template>
  <AppShell>
    <template #actions>
      <ConnectionStatus :status="items.store.status.value" />
      <ShellUser />
    </template>
    <template v-if="description && page.state === 'ready'" #sidebar>
      <FolderSidebar
        :workspace-id="workspaceId"
        :hub-name="description.hub.name"
        :tree="tree"
        :folder-id="page.item.folderId"
        current="location"
      />
    </template>

    <main
      class="box-border flex min-w-0 flex-1 flex-wrap items-start gap-10 px-4 py-6 sm:px-9 sm:py-7"
    >
      <ItemState :page="page" @retry="retry">
        <template #default="{ item, hub }">
          <ItemBody
            ref="body"
            :workspace-id="workspaceId"
            :item="item"
            :hub="hub"
            :columns="folderColumns(hub, item.folderId)"
            :backlinks="backlinks.list.value"
            :history="history.list.value"
            :read-only="readOnly"
            :saving="items.isSaving(item.id)"
            :notice="items.notice.value"
            :refused-value="(attributeId: string) => items.refusedValue(item.id, attributeId)"
            @save="(values, basedOn) => items.save(item.id, values, basedOn)"
            @dismiss-refused="items.forgetRefused(item.id, [$event])"
            @delete="askDelete"
            @dismiss="items.dismissNotice()"
            @retry-backlinks="backlinks.load()"
            @more-backlinks="backlinks.loadMore()"
            @retry-history="history.load()"
            @more-history="history.loadMore()"
            @refresh-history="history.refresh()"
          />
        </template>
      </ItemState>
    </main>

    <ConfirmDialog
      v-model:open="confirming"
      :title="`Delete ${deleteLabel}?`"
      message="The item and its values are deleted, and items that link to it stop showing the link. This cannot be undone."
      confirm-label="Delete item"
      :busy="deleting"
      :error="deleteError"
      @confirm="confirmDelete"
      @close="dialogClosed"
    />
  </AppShell>
</template>
