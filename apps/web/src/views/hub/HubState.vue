<script setup lang="ts">
import type { HubDescription } from '@16bit/core'
import { BaseButton, StateBlock } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'

// The hub page's states before a folder can be shown. The default slot renders the folder.
defineProps<{
  workspaceId: string
  hubId: string
  hub: Load<HubDescription>
  /** The open folder is part of this hub. */
  folderFound: boolean
}>()
defineEmits<{ retry: [] }>()
defineSlots<{ default(): unknown }>()
</script>

<template>
  <StateBlock v-if="hub.state === 'loading'" state="loading" title="Loading hub" :rows="6" />
  <StateBlock
    v-else-if="hub.state === 'error' && (hub.error.isNoPermission || hub.error.status === 404)"
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
      <BaseButton size="sm" @click="$emit('retry')">Try again</BaseButton>
    </template>
  </StateBlock>
  <StateBlock
    v-else-if="!folderFound"
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
  <slot v-else />
</template>
