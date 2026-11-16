<script setup lang="ts">
import { ThemeSwitch } from '../ui/index.ts'
import KitSheet from './kit/KitSheet.vue'
</script>

<template>
  <div class="min-h-screen bg-bg text-ink">
    <header
      class="flex min-h-12 flex-wrap items-center gap-4 border-b border-line px-7 py-2 text-ink"
    >
      <h1 class="m-0 font-display text-name font-medium">Component kit</h1>
      <span class="text-secondary text-ink3">Every shared component in both themes.</span>
      <div class="ml-auto"><ThemeSwitch /></div>
    </header>
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,560px),1fr))]">
      <section aria-label="Light theme" class="theme-light min-w-0 bg-bg p-7 text-ink">
        <KitSheet theme="light" />
      </section>
      <section aria-label="Dark theme" class="theme-dark min-w-0 bg-bg p-7 text-ink">
        <KitSheet theme="dark" />
      </section>
    </div>
  </div>
</template>
