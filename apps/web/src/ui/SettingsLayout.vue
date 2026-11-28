<script setup lang="ts">
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import BrandMark from './BrandMark.vue'
import type { SettingsState } from './settings.ts'
import StateBlock from './StateBlock.vue'
import ThemeSwitch from './ThemeSwitch.vue'

export interface SettingsNavEntry {
  key: string
  label: string
  to: RouteLocationRaw
  /** Danger zone: shown in --danger. */
  danger?: boolean
}

const {
  trail,
  back,
  navLabel,
  sections,
  current,
  title,
  description = '',
  state = 'ready',
  stateTitle = '',
  stateMessage = '',
} = defineProps<{
  /** Where the reader is, after the brand: ["Parcel Tracker", "Engineering", "Hub settings"]. */
  trail: readonly string[]
  /** The way out: { label: "Back to Engineering", to: ... }. */
  back: { label: string; to: RouteLocationRaw }
  /** Names the section navigation: "Hub settings". */
  navLabel: string
  sections: readonly SettingsNavEntry[]
  /** The key of the section on screen. */
  current: string
  /** The page title, Space Grotesk 24. */
  title: string
  description?: string
  /**
   * The whole page. `ready` shows the default slot. loading, error, and no-permission replace
   * the content under the title; not-found (a 404 for a hub opened by ID) and no-permission keep
   * the brand bar and the way back but drop the section navigation, which would lead nowhere.
   */
  state?: SettingsState
  stateTitle?: string
  stateMessage?: string
}>()

defineSlots<{
  default?(): unknown
  /** Left of the title, such as the hub's colour square. */
  leading?(): unknown
  /** Right of the title: a primary action, or the save status. */
  actions?(): unknown
  'state-action'?(): unknown
}>()

const blocked = (s: typeof state) => s === 'not-found' || s === 'no-permission'
</script>

<template>
  <!-- From `md` up the top bar stays put and the content scrolls under it, as in AppShell (D85).
       The section navigation is short, so it stays in place at the top of that scroll. -->
  <div
    class="relative flex min-h-dvh flex-col bg-bg text-ink md:h-dvh md:overflow-hidden"
    data-app-shell
  >
    <header
      class="sticky top-0 z-10 flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line bg-bg px-4 py-2 sm:px-7"
      data-top-bar
    >
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <RouterLink to="/" class="flex items-center gap-2 text-ink no-underline">
          <BrandMark />
          <span class="font-display text-name font-medium">16bit.info</span>
        </RouterLink>
        <span class="min-w-0 text-body text-ink3">{{ trail.join(' / ') }}</span>
      </div>
      <div class="flex items-center gap-4">
        <RouterLink
          :to="back.to"
          class="border-b border-line2 text-secondary text-ink3 no-underline hover:border-line3 hover:text-ink"
          >{{ back.label }}</RouterLink
        >
        <ThemeSwitch />
      </div>
    </header>

    <!-- Section navigation beside the content; at phone width it stacks above it. -->
    <div
      class="relative flex min-w-0 flex-1 flex-col md:min-h-0 md:overflow-y-auto"
      data-content-pane
    >
      <div
        class="mx-auto box-border flex w-full max-w-[1280px] flex-wrap items-start gap-10 px-4 py-7 sm:px-7"
      >
        <nav
          v-if="!blocked(state)"
          :aria-label="navLabel"
          class="flex w-full flex-col gap-px lg:sticky lg:top-7 md:w-[180px] md:shrink-0"
        >
          <RouterLink
            v-for="s in sections"
            :key="s.key"
            :to="s.to"
            :aria-current="s.key === current ? 'page' : undefined"
            :class="[
              'flex min-h-8 items-center rounded-control px-2.5 no-underline',
              s.key === current ? 'bg-selected font-medium' : 'hover:bg-surface',
              s.danger
                ? 'text-danger'
                : s.key === current
                  ? 'text-ink'
                  : 'text-ink2 hover:text-ink',
            ]"
            >{{ s.label }}</RouterLink
          >
        </nav>

        <main class="flex min-w-0 flex-[1_1_560px] flex-col gap-8">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div class="flex min-w-0 flex-col gap-1">
              <div class="flex items-center gap-2.5">
                <slot name="leading" />
                <h1 class="m-0 font-display text-page-title font-medium tracking-[-0.01em]">
                  {{ title }}
                </h1>
              </div>
              <p v-if="description" class="m-0 text-ink2">{{ description }}</p>
            </div>
            <div v-if="$slots.actions && state === 'ready'" class="flex items-center gap-2">
              <slot name="actions" />
            </div>
          </div>
          <slot v-if="state === 'ready'" />
          <StateBlock v-else :state="state" :title="stateTitle" :message="stateMessage" :rows="6">
            <template v-if="$slots['state-action']" #action><slot name="state-action" /></template>
          </StateBlock>
        </main>
      </div>
    </div>
  </div>
</template>
