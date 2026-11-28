<script setup lang="ts">
import BrandMark from './BrandMark.vue'
import ThemeSwitch from './ThemeSwitch.vue'

const { panes } = defineProps<{
  /**
   * The content lays out its own scrolling panes (the hub page's main pane and item panel), so
   * from `md` up its box only clips and does not scroll itself. By default the content box is
   * the one that scrolls.
   */
  panes?: boolean
}>()
</script>

<template>
  <!-- From `md` up the shell is exactly the viewport's height and the page never scrolls: the
       top bar stays put and each pane scrolls on its own (D85, DESIGN.md "Layout"). Below `md`
       the page scrolls as one, under a sticky top bar. -->
  <div
    class="relative flex min-h-dvh flex-col bg-bg text-ink md:h-dvh md:overflow-hidden"
    data-app-shell
  >
    <header
      class="sticky top-0 z-10 flex min-h-12 shrink-0 flex-wrap items-center gap-4 border-b border-line bg-bg px-4 py-2 sm:px-7"
      data-top-bar
    >
      <RouterLink to="/" class="flex items-center gap-2 text-ink no-underline">
        <BrandMark />
        <span class="font-display text-name font-medium">16bit.info</span>
      </RouterLink>
      <div class="ml-auto flex items-center gap-2">
        <slot name="actions" />
        <ThemeSwitch />
      </div>
    </header>
    <!-- Inside a hub: a light sidebar. At phone width it stacks above the content. -->
    <div v-if="$slots.sidebar" class="flex flex-1 flex-col md:min-h-0 md:flex-row">
      <div
        class="relative box-border flex min-w-0 shrink-0 flex-col gap-4 border-b border-line bg-surface px-2.5 py-4 md:w-[208px] md:overflow-y-auto md:border-r md:border-b-0"
        data-sidebar-pane
      >
        <slot name="sidebar" />
      </div>
      <div
        class="relative flex min-w-0 flex-1 flex-col md:min-h-0"
        :class="panes ? 'md:overflow-hidden' : 'md:overflow-y-auto'"
        data-content-pane
      >
        <slot />
      </div>
    </div>
    <div
      v-else
      class="relative flex min-w-0 flex-1 flex-col md:min-h-0"
      :class="panes ? 'md:overflow-hidden' : 'md:overflow-y-auto'"
      data-content-pane
    >
      <slot />
    </div>
  </div>
</template>
