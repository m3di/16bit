<script setup lang="ts">
// Pixel glyphs on a 12 by 12 grid in currentColor, like the "more" and "close" marks.
const { name } = defineProps<{ name: 'sun' | 'moon' }>()
</script>

<template>
  <svg
    aria-hidden="true"
    focusable="false"
    viewBox="0 0 12 12"
    shape-rendering="crispEdges"
    class="size-3"
    :data-glyph="name"
  >
    <path
      v-if="name === 'sun'"
      d="M4 4h4v4h-4zM5 0h2v2h-2zM5 10h2v2h-2zM0 5h2v2h-2zM10 5h2v2h-2zM0 0h2v2h-2zM10 0h2v2h-2zM0 10h2v2h-2zM10 10h2v2h-2z"
      fill="currentColor"
    />
    <path
      v-else
      d="M4 1h1v1h-1zM3 2h2v1h-2zM2 3h2v1h-2zM1 4h3v3h-3zM1 7h4v1h-4zM9 7h2v1h-2zM2 8h8v1h-8zM3 9h6v1h-6zM4 10h4v1h-4z"
      fill="currentColor"
    />
  </svg>
</template>
