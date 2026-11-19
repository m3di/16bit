<script setup lang="ts">
import type { Backlink } from '@16bit/core'
import { computed, useId, watchEffect } from 'vue'
import { BaseButton, FormNotice, RelationChip, StateBlock } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import { useValueContext } from '../hub/context.ts'
import { readableTarget } from '../hub/relations.ts'
import { hiddenNote } from './item-page.ts'
import type { BacklinkList } from './useBacklinks.ts'

// "Linked from": the items that link to this one, and a count of those the reader cannot see.
const { list } = defineProps<{ list: Load<BacklinkList> }>()
defineEmits<{ retry: []; more: [] }>()

const ctx = useValueContext()
const headingId = useId()

// Each linking item is shown with its own hub's prefix, title and attribute name.
watchEffect(() => {
  if (list.state === 'ready') ctx.ensureHubs(new Set(list.data.entries.map((b) => b.item.hubId)))
})

function view(b: Backlink) {
  const hub = ctx.hubLookup(b.item.hubId)
  if (hub === 'loading' || hub === 'error') return { state: hub } as const
  const attribute = hub.attributes.find((a) => a.id === b.attributeId)
  return {
    state: 'ready',
    target: readableTarget(b.item, hub),
    through: attribute?.name ?? '',
  } as const
}

const note = computed(() => (list.state === 'ready' ? hiddenNote(list.data.hidden) : ''))
</script>

<template>
  <section :aria-labelledby="headingId" class="flex flex-col gap-2.5" data-backlinks>
    <h2 :id="headingId" class="m-0 text-body font-medium">Linked from</h2>
    <StateBlock v-if="list.state === 'loading'" state="loading" title="Loading links" :rows="2" />
    <StateBlock
      v-else-if="list.state === 'error'"
      state="error"
      title="Links to this item could not be loaded"
      :message="list.error.message"
    >
      <template #action>
        <BaseButton size="sm" @click="$emit('retry')">Try again</BaseButton>
      </template>
    </StateBlock>
    <template v-else>
      <p
        v-if="list.data.entries.length === 0 && list.data.hidden === 0"
        class="m-0 text-ink3"
        data-backlinks-empty
      >
        No items link here.
      </p>
      <ul v-if="list.data.entries.length > 0" class="m-0 flex list-none flex-col gap-2 p-0">
        <li
          v-for="b in list.data.entries"
          :key="`${b.item.id}/${b.attributeId}`"
          class="flex min-w-0 flex-wrap items-baseline gap-x-2"
          :data-backlink="b.item.id"
        >
          <template v-for="v in [view(b)]" :key="v.state">
            <RelationChip
              v-if="v.state === 'ready'"
              :target="v.target"
              :to="ctx.itemLink(b.item)"
            />
            <RelationChip v-else :target="null" :state="v.state" />
            <span v-if="v.state === 'ready' && v.through" class="text-secondary text-ink3"
              >in {{ v.through }}</span
            >
          </template>
        </li>
      </ul>
      <p v-if="note" class="m-0 text-secondary text-ink3" data-backlinks-hidden>{{ note }}</p>
      <FormNotice v-if="list.data.moreError" data-backlinks-more-error>
        More links could not be loaded. {{ list.data.moreError.message }}
      </FormNotice>
      <div v-if="list.data.nextCursor">
        <BaseButton size="sm" :disabled="list.data.more" @click="$emit('more')">{{
          list.data.more ? 'Loading…' : 'Show more'
        }}</BaseButton>
      </div>
    </template>
  </section>
</template>
