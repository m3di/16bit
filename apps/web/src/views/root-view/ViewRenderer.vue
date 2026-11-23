<script setup lang="ts">
import type { Block } from '@16bit/core'
import { computed } from 'vue'
import { BaseButton, BlockStatus, FormNotice, PageHeader, type LiveStatus } from '../../ui/index.ts'
import BlockNode from './BlockNode.vue'
import { provideRootView } from './context.ts'
import type { RenderNode } from './render-tree.ts'
import type { BlockLoad, DataProblem } from './useRootView.ts'
import './blocks/register.ts'

// A stored root view (D76): the `page` block as PageHeader (its title, else the folder's name,
// and the live dot instead of ConnectionStatus), then its blocks. Each block shows its own
// state; what failed is announced once for the page, not once per block (DESIGN.md).

const {
  page,
  folderName,
  live = null,
  blocks,
  problem = null,
  nameOf,
  unsaved = null,
} = defineProps<{
  /** `null`: the tree could not be read at all. */
  page: Extract<RenderNode, { kind: 'block' }> | null
  folderName: string
  live?: LiveStatus | null
  blocks: Readonly<Record<string, BlockLoad>>
  problem?: DataProblem
  nameOf: (block: Block) => string
  /** The composer's preview: data blocks that show their data only once saved. */
  unsaved?: ReadonlySet<string> | null
}>()
const emit = defineEmits<{ retry: [] }>()

provideRootView({
  load: (id) => blocks[id],
  nameOf: (block) => nameOf(block),
  unsaved: (id) => unsaved?.has(id) === true,
})

const title = computed(() =>
  page?.block.type === 'page' ? (page.block.config.title ?? folderName) : folderName,
)
const problemText = computed(() =>
  problem === 'request'
    ? 'The data for this view could not be loaded.'
    : problem === 'blocks'
      ? 'Some blocks could not be loaded.'
      : '',
)
</script>

<template>
  <div class="flex min-w-0 flex-col gap-6" data-root-view>
    <PageHeader :title="title" :live="live" />
    <FormNotice v-if="problemText" data-view-problem>
      {{ problemText }}
      <template #action>
        <BaseButton size="sm" variant="quiet" @click="emit('retry')">Try again</BaseButton>
      </template>
    </FormNotice>
    <BlockStatus
      v-if="!page"
      state="error"
      title="This view could not be read"
      message="Reload the page to try again."
    />
    <BlockStatus
      v-else-if="page.children.length === 0"
      state="empty"
      title="This view has no blocks yet"
      message=""
    />
    <div v-else class="flex min-w-0 flex-col gap-7">
      <BlockNode
        v-for="child in page.children"
        :key="child.kind === 'block' ? child.block.id : child.id"
        :node="child"
        :level="2"
      />
    </div>
  </div>
</template>
