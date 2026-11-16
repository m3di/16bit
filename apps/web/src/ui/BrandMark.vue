<script setup lang="ts">
const { size = 16 } = defineProps<{ size?: number }>()
</script>

<template>
  <svg
    aria-hidden="true"
    focusable="false"
    :width="size"
    :height="size"
    viewBox="0 0 4 4"
    shape-rendering="crispEdges"
    class="shrink-0"
  >
    <path d="M0 0h2v2h-2zM2 2h2v2h-2z" class="fill-accent" />
    <path d="M2 0h2v2h-2zM0 2h2v2h-2z" class="fill-ink" />
  </svg>
</template>
