<script setup lang="ts">
import { MAX_COLUMNS } from '@16bit/core'
</script>

<template>
  <p class="m-0 text-secondary text-ink3">
    Each block inside is one column, up to {{ MAX_COLUMNS }}. Columns sit side by side and wrap
    below each other on narrow screens.
  </p>
</template>
