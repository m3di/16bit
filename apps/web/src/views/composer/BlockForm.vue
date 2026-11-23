<script setup lang="ts">
import type { Principal } from '@16bit/core'
import { computed } from 'vue'
import { FormNotice } from '../../ui/index.ts'
import { blockForm } from './forms.ts'
import { provideBlockForm } from './form-context.ts'
import { BLOCK_LABELS, type ComposerSchema, type DraftBlock, type TreeError } from './tree.ts'

// The selected block's form, from the registry. Problems its fields don't show (its place in
// the tree, a config path no field has) are listed above it, so none is ever hidden.
const { block, root, path, schema, people, errors } = defineProps<{
  block: DraftBlock
  root: DraftBlock
  /** The block's path in the tree (`root.children.0`). */
  path: string
  schema: ComposerSchema
  people: readonly Principal[]
  /** Problems that belong to this block. */
  errors: readonly TreeError[]
}>()

const { unclaimed } = provideBlockForm({
  block: () => block,
  root: () => root,
  blockPath: () => path,
  schema: () => schema,
  people: () => people,
  errors: () => errors,
})
const form = computed(() => blockForm(block.type))
const others = computed(() => unclaimed())
const where = (e: TreeError) => {
  const rest = e.path.startsWith(`${path}.`) ? e.path.slice(path.length + 1) : ''
  return rest ? ` (at ${rest})` : ''
}
</script>

<template>
  <section
    class="flex min-w-0 flex-col gap-4"
    :aria-label="`${BLOCK_LABELS[block.type]} settings`"
    data-block-form
  >
    <p class="m-0 text-secondary text-ink3">
      {{ BLOCK_LABELS[block.type] }} <span class="font-mono">{{ block.id }}</span>
    </p>
    <FormNotice v-if="others.length > 0" data-block-errors>
      <span v-for="(e, i) in others" :key="i" class="block">{{ e.message }}{{ where(e) }}</span>
    </FormNotice>
    <component :is="form" v-if="form" />
    <p v-else class="m-0 text-secondary text-ink3">This block type has no settings form.</p>
  </section>
</template>
