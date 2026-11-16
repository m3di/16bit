<script setup lang="ts">
import BrandMark from './BrandMark.vue'
import ThemeSwitch from './ThemeSwitch.vue'

const { title, subtitle = '' } = defineProps<{
  /** The page's h1, for example "Sign in". */
  title: string
  subtitle?: string
}>()
</script>

<template>
  <!-- Sign-in, invite acceptance, and other pages outside a workspace. No card: a narrow column. -->
  <div class="flex min-h-screen flex-col bg-bg text-ink">
    <header class="flex min-h-12 items-center gap-2 px-4 py-2 sm:px-7">
      <BrandMark />
      <span class="font-display text-name font-medium">16bit.info</span>
      <div class="ml-auto"><ThemeSwitch /></div>
    </header>
    <main class="flex flex-1 justify-center px-4 pt-16 pb-12 sm:pt-24">
      <div class="flex w-full max-w-[340px] flex-col gap-6">
        <div class="flex flex-col gap-1">
          <h1 class="m-0 font-display text-page-title font-medium">{{ title }}</h1>
          <p v-if="subtitle" class="m-0 text-ink2">{{ subtitle }}</p>
        </div>
        <slot />
        <div v-if="$slots.footer" class="border-t border-line pt-4 text-secondary text-ink3">
          <slot name="footer" />
        </div>
      </div>
    </main>
  </div>
</template>
