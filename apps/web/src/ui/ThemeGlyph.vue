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
      d="M4 4h4v4h-4zM5 0h2v2h-2zM5 10h2v2h-2zM0 5h2v2h-2zM10 5h2v2h-2zM1 1h2v2h-2zM9 1h2v2h-2zM1 9h2v2h-2zM9 9h2v2h-2z"
      fill="currentColor"
    />
    <path
      v-else
      d="M3 1h1v1h-1zM2 2h2v1h-2zM1 3h3v3h-3zM1 6h4v1h-4zM1 7h5v1h-5zM1 8h10v1h-10zM2 9h8v1h-8zM3 10h6v1h-6z"
      fill="currentColor"
    />
  </svg>
</template>
