<script setup lang="ts">
import type { HubDescription, ItemValues, RevisionEntry } from '@16bit/core'
import { computed, nextTick, useId } from 'vue'
import { ActorChip, BaseButton, FormNotice, StateBlock } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import { useValueContext } from '../hub/context.ts'
import { formatTimestamp } from '../hub/values.ts'
import { changeAnchor, changesOf, evidenceLink, isEmpty } from './history.ts'
import HistoryValue from './HistoryValue.vue'
import type { HistoryList } from './useHistory.ts'

// "History": who changed the item, when, what, and why (D63), newest first.
const { list, hub } = defineProps<{ list: Load<HistoryList>; hub: HubDescription }>()
defineEmits<{ retry: []; more: []; refresh: [] }>()

const ctx = useValueContext()
const headingId = useId()

const attributes = computed(() => new Map(hub.attributes.map((a) => [a.id, a])))
const seqs = computed(
  () => new Set(list.state === 'ready' ? list.data.entries.map((e) => e.seq) : []),
)

const verbs: Record<RevisionEntry['op'], string> = {
  create: 'created the item',
  update: 'changed',
  delete: 'deleted the item',
}

function actorOf(id: string) {
  const actor = ctx.actor(id)
  return actor.known ? actor : { id, kind: 'unknown' as const }
}

// Each entry with its changed fields (and their attributes) and its evidence links, worked out
// once per render rather than in the template.
const rows = computed(() => {
  if (list.state !== 'ready') return []
  const entries = list.data.entries
  return entries.map((entry, index) => ({
    entry,
    changes: changesOf(entries, index).map((change) => ({
      ...change,
      attribute: attributes.value.get(change.attributeId),
    })),
    evidence: (entry.cause?.evidence ?? []).map((url) => ({ url, link: evidenceLink(url) })),
  }))
})

const errorTitle = computed(() => {
  if (list.state !== 'error') return ''
  if (list.error.isNotFound) return 'This history is not available'
  return 'The history could not be loaded'
})

// The entry a "follows change N" link points at gets focus, so keyboard readers land on it too.
async function goTo(seq: number) {
  await nextTick()
  const target = document.getElementById(changeAnchor(seq))
  target?.scrollIntoView({ block: 'nearest' })
  target?.focus()
}

const showValue = (v: ItemValues[string] | undefined) => !isEmpty(v)
</script>

<template>
  <section :aria-labelledby="headingId" class="flex flex-col gap-2.5" data-history>
    <h2 :id="headingId" class="m-0 text-body font-medium">History</h2>
    <StateBlock v-if="list.state === 'loading'" state="loading" title="Loading history" :rows="3" />
    <!-- A hidden item answers 404 like a missing one (D45), so the text never says which. -->
    <StateBlock
      v-else-if="list.state === 'error' && list.error.isNotFound"
      state="not-found"
      :title="errorTitle"
      message="It may not exist, or it may not be shared with you."
    />
    <StateBlock
      v-else-if="list.state === 'error' && list.error.isNoPermission"
      state="no-permission"
      title="You do not have access to this history"
    />
    <StateBlock
      v-else-if="list.state === 'error'"
      state="error"
      :title="errorTitle"
      :message="list.error.message"
    >
      <template #action>
        <BaseButton size="sm" @click="$emit('retry')">Try again</BaseButton>
      </template>
    </StateBlock>
    <template v-else>
      <FormNotice v-if="list.data.refreshError" data-history-refresh-error>
        Newer changes could not be loaded. {{ list.data.refreshError.message }}
        <template #action>
          <BaseButton size="sm" variant="quiet" @click="$emit('refresh')">Try again</BaseButton>
        </template>
      </FormNotice>
      <p v-if="list.data.entries.length === 0" class="m-0 text-ink3" data-history-empty>
        No changes recorded yet.
      </p>
      <ol v-else class="m-0 flex list-none flex-col gap-4 p-0">
        <li
          v-for="{ entry, changes, evidence } in rows"
          :id="changeAnchor(entry.seq)"
          :key="entry.seq"
          tabindex="-1"
          class="flex min-w-0 flex-col gap-1.5 rounded-control"
          :data-history-entry="entry.seq"
        >
          <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <ActorChip :actor="actorOf(entry.actor)" />
            <span class="text-ink2">{{ verbs[entry.op] }}</span>
            <time :datetime="entry.at" class="text-secondary text-ink3">{{
              formatTimestamp(entry.at)
            }}</time>
            <span class="font-mono text-secondary text-ink3">change {{ entry.seq }}</span>
          </div>

          <ul
            v-if="changes.length > 0"
            class="m-0 flex list-none flex-col gap-1 p-0"
            :aria-label="`Fields changed in change ${String(entry.seq)}`"
          >
            <li
              v-for="change in changes"
              :key="change.attributeId"
              class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
              :data-history-change="change.attributeId"
            >
              <template v-if="change.attribute">
                <span class="text-secondary text-ink3">{{ change.attribute.name }}</span>
                <template v-if="change.before">
                  <span class="sr-only">from</span>
                  <span v-if="showValue(change.before.value)" class="min-w-0 text-ink3">
                    <HistoryValue
                      :attribute="change.attribute"
                      :value="change.before.value"
                      :label="`${change.attribute.name} before change ${String(entry.seq)}`"
                    />
                  </span>
                  <span v-else class="text-secondary text-ink3">empty</span>
                  <span aria-hidden="true" class="text-ink3">→</span>
                  <span class="sr-only">to</span>
                </template>
                <span v-if="showValue(change.after)" class="min-w-0">
                  <HistoryValue
                    :attribute="change.attribute"
                    :value="change.after"
                    :label="`${change.attribute.name} in change ${String(entry.seq)}`"
                  />
                </span>
                <span v-else class="text-secondary text-ink3">cleared</span>
              </template>
              <!-- Removed since: its name and values are no longer readable. -->
              <span v-else class="text-secondary text-ink3">A removed field</span>
            </li>
          </ul>

          <div
            v-if="entry.cause"
            class="flex min-w-0 flex-col gap-1 border-l border-line2 pl-3"
            data-history-cause
          >
            <p
              v-if="entry.cause.note"
              class="m-0 leading-long break-words whitespace-pre-line text-ink2"
              data-history-note
            >
              {{ entry.cause.note }}
            </p>
            <ul
              v-if="evidence.length > 0"
              class="m-0 flex list-none flex-col gap-1 p-0"
              :aria-label="`Evidence for change ${String(entry.seq)}`"
            >
              <li
                v-for="({ url, link }, i) in evidence"
                :key="i"
                class="min-w-0 text-secondary"
                data-history-evidence
              >
                <a
                  v-if="link"
                  :href="link.href"
                  target="_blank"
                  rel="noopener noreferrer"
                  :title="link.href"
                  class="relative inline-block max-w-full truncate border-b border-line2 align-bottom text-ink no-underline hover:border-line3"
                  ><span>{{ link.host }}</span
                  ><span class="text-ink3">{{ link.rest }}</span
                  ><span class="sr-only"> (opens in a new tab)</span></a
                >
                <!-- Not http or https: text, so it can never run as a link. -->
                <span v-else class="break-all text-ink2">{{ url }}</span>
              </li>
            </ul>
            <p
              v-if="entry.cause.causedBy !== undefined"
              class="m-0 text-secondary text-ink3"
              data-history-follows
            >
              Follows
              <a
                v-if="seqs.has(entry.cause.causedBy)"
                :href="`#${changeAnchor(entry.cause.causedBy)}`"
                class="border-b border-line2 font-mono text-ink no-underline hover:border-line3"
                @click.prevent="goTo(entry.cause.causedBy)"
                >change {{ entry.cause.causedBy }}</a
              >
              <span v-else class="font-mono">change {{ entry.cause.causedBy }}</span>
            </p>
          </div>
        </li>
      </ol>
      <FormNotice v-if="list.data.moreError" data-history-more-error>
        Older changes could not be loaded. {{ list.data.moreError.message }}
      </FormNotice>
      <div v-if="list.data.nextCursor">
        <BaseButton size="sm" :disabled="list.data.more" @click="$emit('more')">{{
          list.data.more ? 'Loading…' : 'Show older'
        }}</BaseButton>
      </div>
    </template>
  </section>
</template>
