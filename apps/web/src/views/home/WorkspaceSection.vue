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
    </div>

    <StateBlock v-if="entry.hubs.state === 'loading'" state="loading" title="Loading hubs" />
    <StateBlock
      v-else-if="entry.hubs.state === 'error' && entry.hubs.error.isNoPermission"
      state="no-permission"
      title="You do not have access to this workspace's hubs"
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
        <HubCard :name="hub.name" :color="hub.color" :count="hub.itemCount" class="flex-1" />
      </li>
    </ul>
  </section>
</template>
