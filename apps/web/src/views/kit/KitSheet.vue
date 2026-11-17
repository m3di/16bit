<script setup lang="ts">
import { ref } from 'vue'
import {
  BaseButton,
  BaseInput,
  BaseSelect,
  FormNotice,
  PALETTE_COLORS,
  PaletteChip,
  PixelAvatar,
  SizeMeter,
  StateBlock,
  StatusDot,
  paletteVar,
} from '../../ui/index.ts'
import KitValues from './KitValues.vue'

const { theme } = defineProps<{ theme: 'light' | 'dark' }>()

const tokens = [
  'bg',
  'surface',
  'line',
  'line2',
  'line3',
  'ink',
  'ink2',
  'ink3',
  'empty',
  'accent',
  'on-accent',
  'success',
  'warning',
  'danger',
  'selected',
] as const

const name = ref('Engineering')
const prefix = ref('PT')
const search = ref('')
const role = ref('editor')
const roles = [
  { value: 'admin', label: 'Hub admin' },
  { value: 'editor', label: 'Editor' },
  { value: 'commenter', label: 'Commenter' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'owner', label: 'Owner', disabled: true },
]
const avatarIds = ['sara', 'tomas', 'qa-agent', 'dana', 'kofi', 'backend-agent', 'u_01', 'u_02']
const counts = [0, 1, 7, 38, 412, 1280, 2345]
</script>

<template>
  <div class="flex flex-col gap-9">
    <h2 class="m-0 font-display text-page-title font-medium">
      {{ theme === 'light' ? 'Light' : 'Dark' }}
    </h2>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Type</h3>
      <p class="m-0 font-display text-page-title font-medium">Page title, 24</p>
      <p class="m-0 font-display text-card-title font-medium">Item or card title, 18</p>
      <p class="m-0 font-display text-number font-medium">1,280</p>
      <p class="m-0 text-name font-medium">Hub name, 14</p>
      <p class="m-0">Body, 13. The quick brown fox jumps over the lazy dog.</p>
      <p class="m-0 font-medium">Emphasis, 13 medium</p>
      <p class="m-0 text-secondary text-ink2">Secondary, 12</p>
      <p class="m-0 text-caption text-ink3">Caption, 11 in ink3</p>
      <p class="m-0 font-mono text-secondary">PT-412 v7</p>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Tokens</h3>
      <ul class="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3 p-0">
        <li v-for="t in tokens" :key="t" class="flex items-center gap-2">
          <span
            class="size-5 shrink-0 rounded-chip border border-line"
            :style="{ background: `var(--${t})` }"
          />
          <span class="font-mono text-secondary text-ink2">--{{ t }}</span>
        </li>
      </ul>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Palette</h3>
      <ul class="m-0 flex list-none flex-wrap gap-3 p-0">
        <li v-for="c in PALETTE_COLORS" :key="c" class="flex items-center gap-2">
          <span class="size-2.5 shrink-0" :style="{ background: paletteVar(c) }" />
          <PaletteChip :color="c">{{ c }}</PaletteChip>
        </li>
      </ul>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Button</h3>
      <div class="flex flex-wrap items-center gap-2">
        <BaseButton variant="primary">Save</BaseButton>
        <BaseButton>Cancel</BaseButton>
        <BaseButton variant="quiet">More</BaseButton>
        <BaseButton danger>Delete hub</BaseButton>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <BaseButton variant="primary" size="sm">Save</BaseButton>
        <BaseButton size="sm">Cancel</BaseButton>
        <BaseButton variant="quiet" size="sm">More</BaseButton>
        <BaseButton danger size="sm">Remove</BaseButton>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <BaseButton variant="primary" disabled>Disabled</BaseButton>
        <BaseButton disabled>Disabled</BaseButton>
        <BaseButton variant="quiet" disabled>Disabled</BaseButton>
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Input</h3>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
        <BaseInput v-model="name" label="Name" />
        <BaseInput v-model="prefix" label="ID prefix" mono hint="Two to four letters." />
        <BaseInput model-value="" label="Description" error="Description is required." />
        <BaseInput model-value="Read only value" label="Disabled" disabled />
        <BaseInput
          v-model="search"
          type="search"
          label="Search items across your hubs"
          label-hidden
          placeholder="Search items across your hubs"
        />
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Select</h3>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
        <BaseSelect v-model="role" label="Hub role" :options="roles" />
        <BaseSelect v-model="role" label="Hub role, small" size="sm" :options="roles" />
        <BaseSelect v-model="role" label="Disabled" disabled :options="roles" />
        <BaseSelect
          model-value=""
          label="With error"
          error="Pick a role."
          :options="[{ value: '', label: 'Choose' }, ...roles]"
        />
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">StatusDot</h3>
      <div class="flex flex-wrap items-center gap-4">
        <StatusDot tone="success" label="Active now" />
        <StatusDot tone="warning" label="At risk" />
        <StatusDot tone="danger" label="Failed" />
        <StatusDot tone="accent" label="In review" />
        <StatusDot label="Idle" />
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">Avatar</h3>
      <ul class="m-0 flex list-none flex-wrap items-center gap-4 p-0">
        <li v-for="id in avatarIds" :key="id" class="flex items-center gap-2">
          <PixelAvatar :id="id" />
          <span class="text-secondary text-ink2">{{ id }}</span>
        </li>
      </ul>
      <div class="flex items-end gap-3">
        <PixelAvatar id="sara" :size="16" label="Sara, 16px" />
        <PixelAvatar id="sara" :size="18" label="Sara, 18px" />
        <PixelAvatar id="sara" :size="25" label="Sara, 25px" />
        <PixelAvatar id="sara" :size="40" label="Sara, 40px" />
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">SizeMeter</h3>
      <ul class="m-0 flex list-none flex-wrap gap-5 p-0">
        <li
          v-for="(n, i) in counts"
          :key="n"
          class="flex items-center gap-2 text-secondary text-ink3"
        >
          <SizeMeter :count="n" :color="PALETTE_COLORS[i * 2] ?? 'indigo'" />
          {{ n.toLocaleString('en') }} items
        </li>
      </ul>
      <p class="m-0 text-caption text-ink3">
        Size squares: under 10 items, under 100, under 1,000, and 1,000 or more.
      </p>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">StateBlock</h3>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        <div class="rounded-card border border-line p-4">
          <StateBlock state="loading" />
        </div>
        <div class="rounded-card border border-line">
          <StateBlock state="empty" message="Items you add to this folder appear here.">
            <template #action><BaseButton size="sm">New item</BaseButton></template>
          </StateBlock>
        </div>
        <div class="rounded-card border border-line">
          <StateBlock state="error" message="The server did not answer. Try again in a moment.">
            <template #action><BaseButton size="sm">Retry</BaseButton></template>
          </StateBlock>
        </div>
        <div class="rounded-card border border-line">
          <StateBlock
            state="no-permission"
            message="Ask a hub admin to give you access to this hub."
          />
        </div>
        <div class="rounded-card border border-line">
          <StateBlock state="not-found" title="This hub is not available">
            <template #action>
              <a href="/kit" class="border-b border-line2 text-ink no-underline hover:border-line3"
                >Back to workspaces</a
              >
            </template>
          </StateBlock>
        </div>
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="m-0 border-b border-line pb-2 text-body font-medium">FormNotice</h3>
      <div class="flex max-w-md flex-col gap-4">
        <div class="flex flex-col gap-2">
          <span class="text-caption text-ink3">Error</span>
          <FormNotice>The invite was not accepted. The server did not answer.</FormNotice>
        </div>
        <div class="flex flex-col gap-2">
          <span class="text-caption text-ink3">Error with an action</span>
          <FormNotice>
            PT-412 was changed by someone else. Your change was not saved.
            <template #action><BaseButton size="sm" variant="quiet">Dismiss</BaseButton></template>
          </FormNotice>
        </div>
        <div class="flex flex-col gap-2">
          <span class="text-caption text-ink3">Info</span>
          <FormNotice tone="info"
            >This account cannot sign in here. Ask an owner or admin for an invite.</FormNotice
          >
        </div>
      </div>
    </section>

    <KitValues />
  </div>
</template>
