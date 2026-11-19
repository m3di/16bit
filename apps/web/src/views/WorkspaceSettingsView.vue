<script setup lang="ts">
import MembersScreen from './workspace/MembersScreen.vue'

const { workspaceId } = defineProps<{ workspaceId: string }>()
</script>

<template>
  <!-- Another workspace gets a fresh page and store. -->
  <MembersScreen :key="workspaceId" :workspace-id="workspaceId" />
</template>
