<script setup lang="ts">
import { BaseButton, StateBlock } from '../../ui/index.ts'
import type { Load, SelfGrant, WorkspaceEntry } from './useDashboard.ts'
import WorkspaceSection from './WorkspaceSection.vue'

const {
  selfGrantIn = () => false,
  createHubIn = () => false,
  selfGrants = new Map<string, SelfGrant>(),
} = defineProps<{
  workspaces: Load<WorkspaceEntry[]>
  /** Whether the reader may grant themselves access to hubs in a workspace. */
  selfGrantIn?: (workspaceId: string) => boolean
  /** Whether the reader may create hubs in a workspace (`hub.create`). */
  createHubIn?: (workspaceId: string) => boolean
  selfGrants?: ReadonlyMap<string, SelfGrant>
}>()
defineEmits<{
  retry: []
  retryHubs: [workspaceId: string]
  grantSelf: [workspaceId: string, hubId: string]
  dismissSelfGrant: [workspaceId: string, hubId: string]
  newHub: [workspaceId: string]
}>()
</script>

<template>
  <StateBlock
    v-if="workspaces.state === 'loading'"
    state="loading"
    title="Loading workspaces"
    :rows="4"
  />
  <StateBlock
    v-else-if="workspaces.state === 'error' && workspaces.error.isNoPermission"
    state="no-permission"
    title="You do not have access to these workspaces"
  />
  <StateBlock
    v-else-if="workspaces.state === 'error'"
    state="error"
    title="Your workspaces could not be loaded"
    :message="workspaces.error.message"
  >
    <template #action>
      <BaseButton size="sm" @click="$emit('retry')">Try again</BaseButton>
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
      :can-self-grant="selfGrantIn(entry.workspace.id)"
      :can-create-hub="createHubIn(entry.workspace.id)"
      :self-grants="selfGrants"
      @retry="$emit('retryHubs', entry.workspace.id)"
      @grant-self="$emit('grantSelf', entry.workspace.id, $event)"
      @dismiss-self-grant="$emit('dismissSelfGrant', entry.workspace.id, $event)"
      @new-hub="$emit('newHub', entry.workspace.id)"
    />
  </template>
</template>
