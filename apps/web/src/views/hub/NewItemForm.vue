<script setup lang="ts">
import type { FolderAttributeDefinition, ItemValues } from '@16bit/core'
import { ref } from 'vue'
import { BaseButton } from '../../ui/index.ts'
import FieldEditor from './FieldEditor.vue'
import { newItemValues } from './newItem.ts'

const {
  columns,
  busy,
  serverErrors = {},
} = defineProps<{
  columns: readonly FolderAttributeDefinition[]
  /** The create request is running. */
  busy?: boolean
  /** Per-attribute errors from an `invalid_values` response. */
  serverErrors?: Record<string, string>
}>()

const emit = defineEmits<{ submit: [values: ItemValues]; cancel: [] }>()

const values = ref<ItemValues>({})
const errors = ref<Record<string, string>>({})

function set(attributeId: string, value: ItemValues[string]) {
  values.value = { ...values.value, [attributeId]: value }
}

function submit() {
  const result = newItemValues(columns, values.value)
  if (!result.ok) {
    errors.value = result.errors
    return
  }
  errors.value = {}
  emit('submit', result.values)
}
</script>

<template>
  <form class="flex flex-col gap-3" novalidate data-new-item @submit.prevent="submit">
    <FieldEditor
      v-for="{ attribute, required } in columns"
      :key="attribute.id"
      :attribute="attribute"
      :value="values[attribute.id]"
      :required="required"
      :error="errors[attribute.id] ?? serverErrors[attribute.id]"
      :disabled="busy"
      @commit="set(attribute.id, $event)"
    />
    <p v-if="columns.length === 0" class="m-0 text-ink2">
      This folder has no fields yet. The item will be created with an ID only.
    </p>
    <div class="flex flex-wrap gap-2 pt-1">
      <BaseButton type="submit" variant="primary" :disabled="busy">
        {{ busy ? 'Creating…' : 'Create item' }}
      </BaseButton>
      <BaseButton variant="quiet" :disabled="busy" @click="emit('cancel')">Cancel</BaseButton>
    </div>
  </form>
</template>
