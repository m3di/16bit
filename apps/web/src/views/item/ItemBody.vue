<script setup lang="ts">
import {
  validateItemValues,
  type FolderAttributeDefinition,
  type HubDescription,
  type Item,
  type ItemValues,
} from '@16bit/core'
import { computed, ref, useId, useTemplateRef } from 'vue'
import { RouterLink } from 'vue-router'
import { BaseButton, FormNotice } from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import ActorValue from '../hub/ActorValue.vue'
import FieldEditor from '../hub/FieldEditor.vue'
import { displayId } from '../hub/relations.ts'
import { formatTimestamp } from '../hub/values.ts'
import BacklinksBlock from './BacklinksBlock.vue'
import { itemTitle } from '../hub/relations.ts'
import { folderLink, itemFolder } from './item-page.ts'
import type { BacklinkList } from './useBacklinks.ts'

// One item on its own page, after the task mockup: the trail and title, the folder's
// attributes as editors, then details and the items that link here beside them.
const {
  workspaceId,
  item,
  hub,
  columns,
  backlinks,
  readOnly,
  saving,
  notice = null,
} = defineProps<{
  workspaceId: string
  item: Item
  hub: HubDescription
  /** The attributes of the item's folder, in position order. */
  columns: readonly FolderAttributeDefinition[]
  backlinks: Load<BacklinkList>
  /** The reader's hub role does not let them change items, or the server refused a write. */
  readOnly: boolean
  /** An edit is on its way to the server. */
  saving: boolean
  /** The last write that failed, until dismissed. */
  notice?: string | null
}>()

const emit = defineEmits<{
  save: [values: ItemValues]
  delete: []
  dismiss: []
  retryBacklinks: []
  moreBacklinks: []
}>()

const fieldsId = useId()
const detailsId = useId()
const title = computed(() => itemTitle(item, hub))
const label = computed(() => displayId(hub, item))
const folder = computed(() => itemFolder(hub, item))

// The page moves focus here when the Delete button it came from is gone (a refused delete).
const readOnlyNote = useTemplateRef<HTMLElement>('readOnlyNote')
defineExpose({ focusReadOnly: () => readOnlyNote.value?.focus() })

const errors = ref<Record<string, string>>({})

// Checked here first with the same rules as the server, so a value it would refuse is not sent.
function commit(attributeId: string, value: ItemValues[string]) {
  if (readOnly) return
  const result = validateItemValues(columns, { [attributeId]: value }, { partial: true })
  if (!result.ok) {
    errors.value = { ...errors.value, [attributeId]: result.errors[0]?.message ?? 'Invalid' }
    return
  }
  errors.value = Object.fromEntries(Object.entries(errors.value).filter(([k]) => k !== attributeId))
  emit('save', result.values)
}
</script>

<template>
  <div class="flex min-w-0 flex-[3_1_440px] flex-col gap-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 flex-col gap-1.5">
        <nav aria-label="Breadcrumb" class="text-secondary text-ink3">
          <ol class="m-0 flex list-none flex-wrap items-baseline gap-x-1.5 p-0">
            <li>
              <RouterLink
                :to="{ name: 'hub', params: { workspaceId, hubId: hub.hub.id } }"
                class="text-ink3 no-underline hover:text-ink"
                >{{ hub.hub.name }}</RouterLink
              >
            </li>
            <li v-if="folder && folder.id !== hub.hub.id" class="flex items-baseline gap-x-1.5">
              <span aria-hidden="true">/</span>
              <RouterLink
                :to="folderLink(workspaceId, item)"
                class="text-ink3 no-underline hover:text-ink"
                >{{ folder.name }}</RouterLink
              >
            </li>
            <li v-if="title" class="flex items-baseline gap-x-1.5">
              <span aria-hidden="true">/</span>
              <span class="font-mono" aria-current="page" data-display-id>{{ label }}</span>
            </li>
          </ol>
        </nav>
        <!-- Without a title (D50) the item is known by its mono ID. -->
        <h1
          v-if="title"
          class="m-0 font-display text-page-title font-medium tracking-[-0.01em] break-words"
        >
          {{ title }}
        </h1>
        <h1 v-else class="m-0 font-mono text-page-title font-normal" data-display-id>
          {{ label }}
        </h1>
      </div>
      <p
        v-if="readOnly"
        ref="readOnlyNote"
        tabindex="-1"
        class="m-0 text-secondary text-ink3"
        data-read-only
      >
        You can view this item but not change it.
      </p>
      <BaseButton v-else danger data-delete-item @click="emit('delete')">Delete item</BaseButton>
    </div>

    <FormNotice v-if="notice" data-notice>
      {{ notice }}
      <template #action>
        <BaseButton size="sm" variant="quiet" @click="emit('dismiss')">Dismiss</BaseButton>
      </template>
    </FormNotice>

    <section :aria-labelledby="fieldsId" class="flex max-w-[620px] flex-col gap-3">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 :id="fieldsId" class="m-0 text-body font-medium">Fields</h2>
        <p class="m-0 text-secondary text-ink3" role="status">{{ saving ? 'Saving…' : '' }}</p>
      </div>
      <FieldEditor
        v-for="{ attribute, required } in columns"
        :key="attribute.id"
        :attribute="attribute"
        :value="item.values[attribute.id]"
        :required="required"
        :error="errors[attribute.id]"
        :read-only="readOnly"
        :item-id="item.id"
        @commit="commit(attribute.id, $event)"
      />
      <p v-if="columns.length === 0" class="m-0 text-ink2">This folder has no fields yet.</p>
    </section>
  </div>

  <aside aria-label="Details" class="flex min-w-0 flex-[2_1_280px] flex-col gap-6">
    <section :aria-labelledby="detailsId" class="flex flex-col gap-2.5">
      <h2 :id="detailsId" class="m-0 text-body font-medium">Details</h2>
      <dl class="m-0 grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt class="text-ink3">ID</dt>
        <dd class="m-0 font-mono text-secondary">{{ label }}</dd>
        <dt class="text-ink3">Version</dt>
        <dd class="m-0 font-mono text-secondary" data-item-version>{{ item.version }}</dd>
        <dt class="text-ink3">Updated</dt>
        <dd class="m-0">
          <time :datetime="item.updatedAt">{{ formatTimestamp(item.updatedAt) }}</time>
        </dd>
        <dt class="text-ink3">Updated by</dt>
        <dd class="m-0 min-w-0"><ActorValue :ids="[item.updatedBy]" label="Updated by" /></dd>
      </dl>
    </section>
    <BacklinksBlock
      :list="backlinks"
      @retry="emit('retryBacklinks')"
      @more="emit('moreBacklinks')"
    />
  </aside>
</template>
