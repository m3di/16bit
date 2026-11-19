<script setup lang="ts">
import type { CreateHub, PaletteColor } from '@16bit/core'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import ShellUser from '../session/ShellUser.vue'
import { AppShell } from '../ui/index.ts'
import { useSession } from '../session/session.ts'
import { useDashboard } from './home/useDashboard.ts'
import WorkspaceList from './home/WorkspaceList.vue'
import NewHubDialog from './home/NewHubDialog.vue'
import { canCreateHub, createHub } from './home/newHub.ts'
import { selfGranter } from './home/selfGrant.ts'

const { workspaces, totals, selfGrants, load, reloadHubs, grantSelf, dismissSelfGrant } =
  useDashboard()

// Who may give themselves access to a hub they see as "no access" follows `can('grant.set')`
// (D45): today owners and admins.
const session = useSession()
const meOrNull = () => (session.me.value.state === 'ready' ? session.me.value.data : null)
const selfGrantIn = (workspaceId: string) => selfGranter(meOrNull(), workspaceId) !== null
function onGrantSelf(workspaceId: string, hubId: string) {
  const viewer = selfGranter(meOrNull(), workspaceId)
  if (viewer) void grantSelf(workspaceId, hubId, viewer.id)
}

// New hubs: owners and admins (`hub.create`). The creator lands in the hub's General settings,
// as its hub admin, to carry on setting it up.
const router = useRouter()
const createHubIn = (workspaceId: string) => canCreateHub(meOrNull(), workspaceId)
const newHubIn = ref<string | null>(null)
const newHubOpen = computed({
  get: () => newHubIn.value !== null,
  set: (open) => {
    if (!open) newHubIn.value = null
  },
})
const newHubEntry = computed(() => {
  const list = workspaces.value
  return list.state === 'ready'
    ? (list.data.find((e) => e.workspace.id === newHubIn.value) ?? null)
    : null
})
const usedColors = computed<PaletteColor[]>(() => {
  const hubs = newHubEntry.value?.hubs
  return hubs?.state === 'ready' ? hubs.data.map((h) => h.color) : []
})
// The dialog cannot close while the create runs, so `newHubIn` holds still meanwhile.
const sendNewHub = (body: CreateHub) => createHub(newHubIn.value ?? '', body)
function onHubCreated(hub: { id: string; workspaceId: string }) {
  void router.push({
    name: 'hub-settings-general',
    params: { workspaceId: hub.workspaceId, hubId: hub.id },
  })
}

onMounted(() => {
  void load()
})

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`

// Hidden with no workspaces: the empty state already says so.
const summary = computed(() =>
  totals.value?.workspaces
    ? `${plural(totals.value.hubs, 'hub', 'hubs')} in ${plural(totals.value.workspaces, 'workspace', 'workspaces')}.`
    : '',
)
</script>

<template>
  <AppShell>
    <template #actions><ShellUser /></template>
    <main
      class="mx-auto box-border flex w-full max-w-[1280px] min-w-0 flex-col gap-9 px-4 py-8 sm:px-7"
    >
      <div class="flex flex-col gap-1">
        <h1 class="m-0 font-display text-page-title font-medium tracking-[-0.01em]">Workspaces</h1>
        <span v-if="summary" class="text-ink2" data-summary>{{ summary }}</span>
      </div>

      <WorkspaceList
        :workspaces="workspaces"
        :self-grant-in="selfGrantIn"
        :create-hub-in="createHubIn"
        :self-grants="selfGrants"
        @retry="load()"
        @retry-hubs="reloadHubs"
        @grant-self="onGrantSelf"
        @dismiss-self-grant="dismissSelfGrant"
        @new-hub="newHubIn = $event"
      />
      <NewHubDialog
        v-model:open="newHubOpen"
        :workspace-name="newHubEntry?.workspace.name ?? ''"
        :used-colors="usedColors"
        :create="sendNewHub"
        @created="onHubCreated"
      />
    </main>
  </AppShell>
</template>
