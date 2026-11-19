<script setup lang="ts">
import { computed, onMounted } from 'vue'
import ShellUser from '../session/ShellUser.vue'
import { AppShell } from '../ui/index.ts'
import { useSession } from '../session/session.ts'
import { viewerOf } from './hub-settings/access.ts'
import { useDashboard } from './home/useDashboard.ts'
import WorkspaceList from './home/WorkspaceList.vue'

const { workspaces, totals, selfGrants, load, reloadHubs, grantSelf, dismissSelfGrant } =
  useDashboard()
const session = useSession()

// Owners and admins may grant themselves access to a hub they see as "no access" (D45).
const selfIn = (workspaceId: string) => {
  const me = session.me.value
  const viewer = viewerOf(me.state === 'ready' ? me.data : null, workspaceId)
  return viewer && (viewer.workspaceRole === 'owner' || viewer.workspaceRole === 'admin')
    ? viewer
    : null
}
const selfGrantIn = (workspaceId: string) => selfIn(workspaceId) !== null
function onGrantSelf(workspaceId: string, hubId: string) {
  const viewer = selfIn(workspaceId)
  if (viewer) void grantSelf(workspaceId, hubId, viewer.id)
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
        :self-grants="selfGrants"
        @retry="load()"
        @retry-hubs="reloadHubs"
        @grant-self="onGrantSelf"
        @dismiss-self-grant="dismissSelfGrant"
      />
    </main>
  </AppShell>
</template>
