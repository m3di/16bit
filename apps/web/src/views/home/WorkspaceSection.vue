<script setup lang="ts">
import { computed } from 'vue'
import { BaseButton, HubCard, StateBlock } from '../../ui/index.ts'
import type { WorkspaceEntry } from './useDashboard.ts'

const { entry } = defineProps<{ entry: WorkspaceEntry }>()
defineEmits<{ retry: [] }>()

const headingId = computed(() => `workspace-${entry.workspace.id}`)
</script>

<template>
  <section :aria-labelledby="headingId" class="flex flex-col gap-3.5" data-workspace>
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2">
      <h2 :id="headingId" class="m-0 text-body font-medium">{{ entry.workspace.name }}</h2>
      <!-- Every person in the workspace may see its members; what they can change follows the role. -->
      <RouterLink
        :to="{ name: 'workspace-members', params: { workspaceId: entry.workspace.id } }"
        class="border-b border-line2 text-secondary text-ink3 no-underline hover:border-line3 hover:text-ink"
        data-members-link
        >Members and roles<span class="sr-only"> of {{ entry.workspace.name }}</span></RouterLink
      >
    </div>

    <StateBlock v-if="entry.hubs.state === 'loading'" state="loading" title="Loading hubs" />
    <StateBlock
      v-else-if="entry.hubs.state === 'error' && entry.hubs.error.isNoPermission"
      state="no-permission"
      title="You do not have access to this workspace's hubs"
    />
    <StateBlock
      v-else-if="entry.hubs.state === 'error' && entry.hubs.error.isNotFound"
      state="not-found"
      title="This workspace is not available"
      message="It may have been deleted, or you may no longer belong to it."
    />
    <StateBlock
      v-else-if="entry.hubs.state === 'error'"
      state="error"
      title="The hubs could not be loaded"
      :message="entry.hubs.error.message"
    >
      <template #action>
        <BaseButton size="sm" @click="$emit('retry')">Try again</BaseButton>
      </template>
    </StateBlock>
    <StateBlock
      v-else-if="entry.hubs.data.length === 0"
      state="empty"
      title="No hubs yet"
      message="Hubs in this workspace will show here."
    />
    <ul v-else class="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-0">
      <li v-for="hub in entry.hubs.data" :key="hub.id" class="flex min-w-0 flex-col">
        <HubCard
          v-if="hub.access === 'granted'"
          :name="hub.name"
          :color="hub.color"
          :count="hub.itemCount"
          :to="{ name: 'hub', params: { workspaceId: hub.workspaceId, hubId: hub.id } }"
          class="flex-1"
        />
        <!-- Owners and admins without a grant: name only. Self-granting is API-only in M1. -->
        <HubCard v-else :name="hub.name" :color="hub.color" no-access class="flex-1" />
      </li>
    </ul>
  </section>
</template>
