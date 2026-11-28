<script setup lang="ts">
// A pixel plus on a 10 by 10 grid in currentColor, with 2px arms like the "more" squares.
// It leads "New item" through BaseButton's icon slot, which hides it from the name.
</script>

<template>
  <svg
    aria-hidden="true"
    focusable="false"
    viewBox="0 0 10 10"
    shape-rendering="crispEdges"
    class="size-2.5 shrink-0"
    data-glyph="plus"
  >
    <path d="M4 0h2v10h-2zM0 4h10v2h-10z" fill="currentColor" />
  </svg>
</template>
