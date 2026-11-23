<script setup lang="ts">
import { BLOCK_TYPES } from '@16bit/core'
import { computed, onErrorCaptured, ref, useId, watch } from 'vue'
import { BlockStatus } from '../../ui/index.ts'
import DataBlockStates from './blocks/DataBlockStates.vue'
import { useRootViewContext } from './context.ts'
import { blockComponent } from './registry.ts'
import { HEADED_DATA_BLOCKS, type RenderNode } from './render-tree.ts'

// One block of a root view and its own error boundary: anything a block throws while it renders
// replaces that block alone with a compact error, and the rest of the page goes on (D18).

const { node, level } = defineProps<{
  node: RenderNode
  /** The heading level this block's own headings start at: 2 under the page. */
  level: number
}>()

const context = useRootViewContext()
const failed = ref(false)
onErrorCaptured((error) => {
  failed.value = true
  console.error(error)
  return false
})
// A new tree (the view was saved again) gets another chance.
watch(
  () => node,
  () => {
    failed.value = false
  },
)

const block = computed(() => (node.kind === 'block' ? node.block : null))
const category = computed(() => (block.value ? BLOCK_TYPES[block.value.type].category : null))
const component = computed(() => {
  const b = block.value
  if (!b) return null
  return blockComponent(b.type) ?? (category.value === 'data' ? DataBlockStates : null)
})
// A titled section is the h2 its children sit under.
const childLevel = computed(() =>
  block.value?.type === 'section' && block.value.config.title ? level + 1 : level,
)
// A list's groups and a board's columns are h3s: outside a titled section they get one, so the
// outline never goes from the page's h1 straight to an h3.
const wrapped = computed(
  () => !!block.value && HEADED_DATA_BLOCKS.has(block.value.type) && level < 3,
)
const headingId = useId()
</script>

<template>
  <BlockStatus
    v-if="failed || !block || !component"
    state="error"
    title="This block could not be shown"
    message="Reload the page to try again."
    :data-view-block="node.kind === 'block' ? node.block.id : node.id"
    data-block-broken
  />
  <section
    v-else-if="wrapped"
    :aria-labelledby="headingId"
    class="flex min-w-0 flex-col"
    data-block-outline
  >
    <h2 :id="headingId" class="sr-only">{{ context.nameOf(block) }}</h2>
    <component
      :is="component"
      :block="block"
      :load="context.load(block.id) ?? null"
      :level="level + 1"
    />
  </section>
  <component
    :is="component"
    v-else-if="category === 'data'"
    :block="block"
    :load="context.load(block.id) ?? null"
    :level="level"
  />
  <component :is="component" v-else-if="category === 'layout'" :block="block" :level="level">
    <BlockNode
      v-for="child in node.children"
      :key="child.kind === 'block' ? child.block.id : child.id"
      :node="child"
      :level="childLevel"
    />
  </component>
  <component :is="component" v-else :block="block" :level="level" />
</template>
