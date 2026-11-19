<script setup lang="ts">
import { onMounted } from 'vue'
import { useSession } from '../../session/session.ts'
import HubSettingsPage from './HubSettingsPage.vue'
import type { HubSettingsSection } from './schema.ts'
import { useHubAccess } from './useHubAccess.ts'
import { useHubSettings } from './useHubSettings.ts'

const { workspaceId, hubId, section } = defineProps<{
  workspaceId: string
  hubId: string
  section: HubSettingsSection
}>()

const session = useSession()
const model = useHubSettings(workspaceId, hubId, (...args) => fetch(...args))
const access = useHubAccess(workspaceId, hubId, (...args) => fetch(...args))

onMounted(async () => {
  // The reader's workspace role comes from the session; the hub role from the hub.
  await Promise.all([session.ensure(), model.load()])
})
</script>

<template>
  <HubSettingsPage
    :workspace-id="workspaceId"
    :hub-id="hubId"
    :section="section"
    :model="model"
    :access="access"
    :me="session.me.value"
  />
</template>
