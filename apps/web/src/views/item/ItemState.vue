<script setup lang="ts">
import type { HubDescription, Item } from '@16bit/core'
import { BaseButton, StateBlock } from '../../ui/index.ts'
import type { PageState } from './item-page.ts'

// The item page's states. The default slot renders the item once it and its hub are loaded.
defineProps<{ page: PageState }>()
defineEmits<{ retry: [] }>()
defineSlots<{ default(props: { item: Item; hub: HubDescription }): unknown }>()
</script>

<template>
  <div v-if="page.state === 'loading'" class="w-full max-w-3xl">
    <StateBlock state="loading" title="Loading item" :rows="6" />
  </div>
  <!-- A hidden item answers 404 like a missing one (D45), so the text never says which. -->
  <div v-else-if="page.state === 'not-found'" class="w-full">
    <StateBlock
      state="not-found"
      title="This item is not available"
      message="It may not exist, or it may not be shared with you."
    >
      <template #action>
        <RouterLink to="/" class="border-b border-line2 text-ink no-underline hover:border-line3"
          >Back to workspaces</RouterLink
        >
      </template>
    </StateBlock>
  </div>
  <div v-else-if="page.state === 'no-permission'" class="w-full">
    <StateBlock state="no-permission" title="You do not have access to this item">
      <template #action>
        <RouterLink to="/" class="border-b border-line2 text-ink no-underline hover:border-line3"
          >Back to workspaces</RouterLink
        >
      </template>
    </StateBlock>
  </div>
  <div v-else-if="page.state === 'error'" class="w-full">
    <StateBlock state="error" title="The item could not be loaded" :message="page.error.message">
      <template #action>
        <BaseButton size="sm" @click="$emit('retry')">Try again</BaseButton>
      </template>
    </StateBlock>
  </div>
  <slot v-else-if="page.state === 'ready'" :item="page.item" :hub="page.hub" />
</template>
