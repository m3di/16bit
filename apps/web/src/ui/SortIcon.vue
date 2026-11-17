<script setup lang="ts">
// DataTable's sort cue. At rest, two chevrons mark a sortable column; a sorted column shows one
// centred chevron for its direction. It keeps one width in every state, so the label never
// moves. Colour comes from the header button (--ink3 at rest, --ink when sorted), and the
// header's aria-sort carries the state for screen readers.
defineProps<{ sort: 'ascending' | 'descending' | 'none' }>()
</script>

<template>
  <svg
    aria-hidden="true"
    viewBox="0 0 10 14"
    width="10"
    height="14"
    fill="none"
    stroke="currentColor"
    stroke-width="1"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="shrink-0"
    :data-sort-icon="sort"
  >
    <path v-if="sort === 'none'" d="M2 5.5 5 2.5l3 3" data-chevron="up" />
    <path v-if="sort === 'none'" d="M2 8.5 5 11.5l3-3" data-chevron="down" />
    <path v-if="sort === 'ascending'" d="M2 8.5 5 5.5l3 3" data-chevron="up" />
    <path v-if="sort === 'descending'" d="M2 5.5 5 8.5l3-3" data-chevron="down" />
  </svg>
</template>
