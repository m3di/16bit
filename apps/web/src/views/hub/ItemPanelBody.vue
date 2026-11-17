<script setup lang="ts">
import type { Item } from '@16bit/core'
import { BaseButton, StateBlock } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'

// The item panel's states. The default slot renders the loaded item.
defineProps<{ item: Load<Item> }>()
defineEmits<{ retry: [] }>()
defineSlots<{ default(props: { item: Item }): unknown }>()
</script>

<template>
  <StateBlock v-if="item.state === 'loading'" state="loading" title="Loading item" />
  <StateBlock
    v-else-if="item.state === 'error' && item.error.isNoPermission"
    state="no-permission"
    title="You do not have access to this item"
  />
  <StateBlock
    v-else-if="item.state === 'error' && item.error.status === 404"
    state="not-found"
    title="This item could not be found"
    message="It may have been deleted, or it belongs to another hub."
  />
  <StateBlock
    v-else-if="item.state === 'error'"
    state="error"
    title="The item could not be loaded"
    :message="item.error.message"
  >
    <template #action>
      <BaseButton size="sm" @click="$emit('retry')">Try again</BaseButton>
    </template>
  </StateBlock>
  <slot v-else :item="item.data" />
</template>
