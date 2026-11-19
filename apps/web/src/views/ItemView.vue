<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ItemPage from './item/ItemPage.vue'

const route = useRoute()
const param = (name: string) => {
  const value = route.params[name]
  return typeof value === 'string' ? value : ''
}
const workspaceId = computed(() => param('workspaceId'))
const itemId = computed(() => param('itemId'))
</script>

<template>
  <!-- Another item gets a fresh page and store. -->
  <ItemPage :key="`${workspaceId}/${itemId}`" :workspace-id="workspaceId" :item-id="itemId" />
</template>
