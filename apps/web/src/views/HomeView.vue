<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { AppShell, BaseButton, StateBlock } from '../ui/index.ts'
import { useDashboard } from './home/useDashboard.ts'
import WorkspaceSection from './home/WorkspaceSection.vue'

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

      <StateBlock
        v-if="workspaces.state === 'loading'"
        state="loading"
        title="Loading workspaces"
        :rows="4"
      />
      <StateBlock
        v-else-if="workspaces.state === 'error' && workspaces.error.isNoPermission"
        state="no-permission"
        title="The API did not accept this session"
        message="Sign-in arrives in M1. For now, check DEV_API_KEY in your .env."
      />
      <StateBlock
        v-else-if="workspaces.state === 'error'"
        state="error"
        title="Your workspaces could not be loaded"
        :message="workspaces.error.message"
      >
        <template #action>
          <BaseButton size="sm" @click="load()">Try again</BaseButton>
        </template>
      </StateBlock>
      <StateBlock
        v-else-if="workspaces.data.length === 0"
        state="empty"
        title="No workspaces yet"
        message="Workspaces you belong to will show here."
      />
      <template v-else>
        <WorkspaceSection
          v-for="entry in workspaces.data"
          :key="entry.workspace.id"
          :entry="entry"
          @retry="reloadHubs(entry.workspace.id)"
        />
      </template>
    </main>
  </AppShell>
</template>
