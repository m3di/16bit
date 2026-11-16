<script setup lang="ts">
import ThemeSwitch from './ThemeSwitch.vue'
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg text-ink">
    <header
      class="flex min-h-12 flex-wrap items-center gap-4 border-b border-line px-4 py-2 sm:px-7"
    >
      <RouterLink to="/" class="flex items-center gap-2 text-ink no-underline">
        <svg
          aria-hidden="true"
          focusable="false"
          width="16"
          height="16"
          viewBox="0 0 4 4"
          shape-rendering="crispEdges"
        >
          <path d="M0 0h2v2h-2zM2 2h2v2h-2z" class="fill-accent" />
          <path d="M2 0h2v2h-2zM0 2h2v2h-2z" class="fill-ink" />
        </svg>
        <span class="font-display text-name font-medium">16bit.info</span>
      </RouterLink>
      <div class="ml-auto flex items-center gap-2">
        <slot name="actions" />
        <ThemeSwitch />
      </div>
    </header>
    <slot />
  </div>
</template>
