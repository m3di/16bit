<script setup lang="ts">
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import StateBlock from './StateBlock.vue'

// A views-only folder with no stored view (D76): it holds no items, so its default view has
// nothing to show. A hub admin gets "Compose", which opens the composer on this folder; everyone
// else is told who can add one. Not an error, so not an alert.
const { composeTo = null } = defineProps<{
  /** Where "Compose" leads. Pass it only to a hub admin (D78); without it there is no link. */
  composeTo?: RouteLocationRaw | null
}>()
</script>

<template>
  <div data-block="no-view">
    <StateBlock
      state="empty"
      title="No view yet"
      :message="
        composeTo
          ? 'This folder only shows views, and none has been composed for it.'
          : 'This folder only shows views, and none has been composed for it yet. A hub admin can add one.'
      "
    >
      <template v-if="composeTo" #action>
        <RouterLink
          :to="composeTo"
          class="inline-flex min-h-8 items-center rounded-control border border-accent bg-accent px-3 text-on-accent"
          >Compose</RouterLink
        >
      </template>
    </StateBlock>
  </div>
</template>
