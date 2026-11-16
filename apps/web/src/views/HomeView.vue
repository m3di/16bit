<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { AppShell } from '../ui/index.ts'
import { useDashboard } from './home/useDashboard.ts'
import WorkspaceList from './home/WorkspaceList.vue'

const { workspaces, totals, load, reloadHubs } = useDashboard()

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
    <main
      class="mx-auto box-border flex w-full max-w-[1280px] min-w-0 flex-col gap-9 px-4 py-8 sm:px-7"
    >
      <div class="flex flex-col gap-1">
        <h1 class="m-0 font-display text-page-title font-medium tracking-[-0.01em]">Workspaces</h1>
        <span v-if="summary" class="text-ink2" data-summary>{{ summary }}</span>
      </div>

      <WorkspaceList :workspaces="workspaces" @retry="load()" @retry-hubs="reloadHubs" />
    </main>
  </AppShell>
</template>
