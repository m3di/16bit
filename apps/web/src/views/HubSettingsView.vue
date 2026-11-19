<script setup lang="ts">
import HubSettingsScreen from './hub-settings/HubSettingsScreen.vue'
import type { HubSettingsSection } from './hub-settings/schema.ts'

const { workspaceId, hubId, section } = defineProps<{
  workspaceId: string
  hubId: string
  section: HubSettingsSection
}>()
</script>

<template>
  <!-- Another hub gets a fresh page and store; moving between sections keeps them. -->
  <HubSettingsScreen
    :key="`${workspaceId}/${hubId}`"
    :workspace-id="workspaceId"
    :hub-id="hubId"
    :section="section"
  />
</template>
