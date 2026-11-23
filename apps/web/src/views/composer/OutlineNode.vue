<script setup lang="ts">
import { computed } from 'vue'
import { BaseButton } from '../../ui/index.ts'
import { summaryOf } from './defaults.ts'
import { useOutlineFocus } from './outline-focus.ts'
import { BLOCK_LABELS, type ComposerSchema, type DraftBlock } from './tree.ts'

// One block in the outline: a button that selects it, and move up, move down and remove. The
// page is the root: it is never moved or removed. No drag and drop (Q10).
const { block, index, count, selected, problems, schema, root } = defineProps<{
  block: DraftBlock
  index: number
  /** Siblings, this one included. */
  count: number
  selected: string | null
  /** Problems per block ID. */
  problems: ReadonlyMap<string, number>
  schema: ComposerSchema | null
  root?: boolean
}>()
const emit = defineEmits<{
  select: [id: string]
  move: [id: string, by: -1 | 1]
  remove: [id: string]
}>()

const name = computed(() => {
  const summary = summaryOf(block, schema)
  return summary ? `${BLOCK_LABELS[block.type]}: ${summary}` : BLOCK_LABELS[block.type]
})
const issues = computed(() => problems.get(block.id) ?? 0)
const focus = useOutlineFocus()
</script>

<template>
  <li class="flex min-w-0 flex-col" :data-outline-block="block.id">
    <div
      :class="[
        'flex min-h-8 flex-wrap items-center gap-1 rounded-control pl-1',
        selected === block.id ? 'bg-selected' : '',
      ]"
    >
      <button
        :ref="focus.register(block.id, 'select')"
        type="button"
        class="min-w-0 flex-[1_1_120px] cursor-pointer truncate border-0 bg-transparent px-1 py-1 text-left text-body text-ink"
        :aria-current="selected === block.id ? 'true' : undefined"
        data-outline-select
        @click="emit('select', block.id)"
      >
        {{ name }}
        <span v-if="issues > 0" class="text-secondary text-danger" data-outline-problems>
          · {{ issues === 1 ? 'needs fixing' : `${issues} problems` }}</span
        >
      </button>
      <template v-if="!root">
        <BaseButton
          :ref="focus.register(block.id, 'up')"
          size="sm"
          variant="quiet"
          :disabled="index === 0"
          :aria-label="`Move ${name} up`"
          @click="emit('move', block.id, -1)"
          >Up</BaseButton
        >
        <BaseButton
          :ref="focus.register(block.id, 'down')"
          size="sm"
          variant="quiet"
          :disabled="index === count - 1"
          :aria-label="`Move ${name} down`"
          @click="emit('move', block.id, 1)"
          >Down</BaseButton
        >
        <BaseButton
          size="sm"
          variant="quiet"
          danger
          :aria-label="`Remove ${name}`"
          @click="emit('remove', block.id)"
          >Remove</BaseButton
        >
      </template>
    </div>
    <ul
      v-if="block.children && block.children.length > 0"
      class="m-0 flex list-none flex-col border-l border-line py-0 pl-3"
      :aria-label="`Inside ${name}`"
    >
      <OutlineNode
        v-for="(child, i) in block.children"
        :key="child.id"
        :block="child"
        :index="i"
        :count="block.children.length"
        :selected="selected"
        :problems="problems"
        :schema="schema"
        @select="emit('select', $event)"
        @move="(id, by) => emit('move', id, by)"
        @remove="emit('remove', $event)"
      />
    </ul>
  </li>
</template>
