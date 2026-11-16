<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import HubPage from './hub/HubPage.vue'

const route = useRoute()
const param = (name: string) => {
  const value = route.params[name]
  return typeof value === 'string' && value !== '' ? value : null
}
const workspaceId = computed(() => param('workspaceId') ?? '')
const hubId = computed(() => param('hubId') ?? '')
const itemId = computed(() =>
  typeof route.query['item'] === 'string' ? route.query['item'] : null,
)
</script>

<template>
  <!-- A new hub gets a fresh page and store; folder and item changes reuse them. -->
  <HubPage
    :key="`${workspaceId}/${hubId}`"
    :workspace-id="workspaceId"
    :hub-id="hubId"
    :folder-id="param('folderId')"
    :item-id="itemId"
  />
</template>
