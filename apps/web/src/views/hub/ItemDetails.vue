<script setup lang="ts">
import type { FolderAttributeDefinition, Item, ItemValues } from '@16bit/core'
import { validateItemValues } from '@16bit/core'
import { ref, useId } from 'vue'
import FieldEditor from './FieldEditor.vue'
import { formatTimestamp } from './values.ts'

const { item, columns, saving, disabled } = defineProps<{
  item: Item
  columns: readonly FolderAttributeDefinition[]
  /** An edit is on its way to the server. */
  saving?: boolean
  /** The item is not confirmed by the server yet, so it cannot be edited. */
  disabled?: boolean
}>()

const emit = defineEmits<{ save: [values: ItemValues] }>()

const headingId = useId()
const errors = ref<Record<string, string>>({})

// Checked here first with the same rules as the server, so a value it would refuse is not sent.
function commit(attributeId: string, value: ItemValues[string]) {
  if (disabled) return
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
  <div class="flex flex-col gap-5">
    <p class="m-0 h-4 text-secondary text-ink3" role="status">{{ saving ? 'Saving…' : '' }}</p>

    <section aria-label="Fields" class="flex flex-col gap-3">
      <FieldEditor
        v-for="{ attribute, required } in columns"
        :key="attribute.id"
        :attribute="attribute"
        :value="item.values[attribute.id]"
        :required="required"
        :error="errors[attribute.id]"
        :disabled="disabled"
        @commit="commit(attribute.id, $event)"
      />
      <p v-if="columns.length === 0" class="m-0 text-ink2">This folder has no fields yet.</p>
    </section>

    <section :aria-labelledby="headingId" class="flex flex-col gap-2">
      <h3 :id="headingId" class="m-0 text-body font-medium">Details</h3>
      <dl class="m-0 grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt class="text-ink3">ID</dt>
        <dd class="m-0 font-mono text-secondary break-all" data-item-id>{{ item.id }}</dd>
        <dt class="text-ink3">Version</dt>
        <dd class="m-0 font-mono text-secondary" data-item-version>{{ item.version }}</dd>
        <dt class="text-ink3">Updated</dt>
        <dd class="m-0">
          <time :datetime="item.updatedAt">{{ formatTimestamp(item.updatedAt) }}</time>
        </dd>
        <dt class="text-ink3">Updated by</dt>
        <dd class="m-0 font-mono text-secondary break-all">{{ item.updatedBy }}</dd>
      </dl>
    </section>
  </div>
</template>
