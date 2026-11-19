<script setup lang="ts">
import type { Attribute, HubDescription, SelectOption } from '@16bit/core'
import { computed, ref, useId, watch } from 'vue'
import {
  AttributeTypePicker,
  BaseButton,
  BaseDialog,
  BaseInput,
  BaseSelect,
  ConfirmDialog,
  FormNotice,
  OptionsEditor,
  ToggleSwitch,
  optionErrors,
} from '../../ui/index.ts'
import {
  buildCreateAttribute,
  configSummary,
  emptyDraft,
  strippedValuesMessage,
  type AttributeDraft,
  type DraftField,
} from './schema.ts'
import type { HubSettings } from './useHubSettings.ts'

const open = defineModel<boolean>('open', { default: false })

const { description, attributeId, model } = defineProps<{
  description: HubDescription
  /** The attribute to change, or null for a new one. */
  attributeId: string | null
  model: HubSettings
}>()

const emit = defineEmits<{ saved: [attribute: Attribute, created: boolean] }>()

const formId = useId()
const attribute = computed(() =>
  attributeId ? (description.attributes.find((a) => a.id === attributeId) ?? null) : null,
)
const draft = ref<AttributeDraft>(emptyDraft(description.hub.id))
const errors = ref<Partial<Record<DraftField, string>>>({})
const error = ref('')
const busy = ref(false)
// D51: removing options that items hold asks again with the server's count.
const confirmOpen = ref(false)
const affected = ref(0)

function fill() {
  const a = attribute.value
  draft.value = emptyDraft(description.hub.id)
  if (!a) return
  draft.value.name = a.name
  draft.value.type = a.type
  if (a.type === 'select' || a.type === 'multi_select') {
    draft.value.options = a.config.options.map((o) => ({ ...o }))
  }
}

watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    fill()
    errors.value = {}
    error.value = ''
  },
  { immediate: true },
)

watch(
  () => draft.value.type,
  (type) => {
    if (type === 'relation') {
      void model.loadTargets()
      // Relations default to several links; actors to one person (core defaults).
      if (!attribute.value) draft.value.multiple = true
    } else if (type === 'actor' && !attribute.value) {
      draft.value.multiple = false
    }
  },
)

const hasOptions = computed(
  () => draft.value.type === 'select' || draft.value.type === 'multi_select',
)
const isTitle = computed(
  () => !!attribute.value && description.hub.titleAttributeId === attribute.value.id,
)

const targetChoices = computed(() => {
  const own = { value: description.hub.id, label: `${description.hub.name} (this hub)` }
  const t = model.targets.value
  if (t.state !== 'ready') return [own]
  return [
    own,
    ...t.data
      .filter((h) => h.id !== description.hub.id)
      .map((h) => ({ value: h.id, label: h.name })),
  ]
})

const hubName = (id: string) => {
  if (id === description.hub.id) return `${description.hub.name} (this hub)`
  const t = model.targets.value
  return (t.state === 'ready' && t.data.find((h) => h.id === id)?.name) || 'another hub'
}

const numberFormats = [
  { value: 'plain', label: 'Plain number' },
  { value: 'percent', label: 'Percent' },
  { value: 'currency', label: 'Currency' },
]

const title = computed(() => (attribute.value ? `Edit ${attribute.value.name}` : 'New attribute'))

async function submit() {
  if (busy.value) return
  error.value = ''
  if (attribute.value) await saveExisting()
  else await create()
}

async function create() {
  const built = buildCreateAttribute(draft.value, description.hub.id)
  if (!built.ok) {
    errors.value = built.errors
    return
  }
  errors.value = {}
  busy.value = true
  const result = await model.createAttribute(built.body)
  busy.value = false
  if (result.ok) {
    open.value = false
    emit('saved', result.data, true)
  } else {
    error.value = result.message
  }
}

function change(a: Attribute): { name?: string; options?: SelectOption[] } {
  const name = draft.value.name.trim()
  const out: { name?: string; options?: SelectOption[] } = {}
  if (name !== a.name) out.name = name
  if (a.type === 'select' || a.type === 'multi_select') {
    const options = draft.value.options.map((o) => ({ ...o, label: o.label.trim() }))
    if (JSON.stringify(options) !== JSON.stringify(a.config.options)) out.options = options
  }
  return out
}

async function saveExisting(confirm?: number) {
  const a = attribute.value
  if (!a) return
  errors.value = draft.value.name.trim() ? {} : { name: 'Name the attribute.' }
  if (hasOptions.value && Object.keys(optionErrors(draft.value.options)).length > 0) {
    errors.value = { ...errors.value, options: 'Fix the options marked above.' }
  }
  if (Object.keys(errors.value).length > 0) return
  const body = change(a)
  if (Object.keys(body).length === 0) {
    open.value = false
    return
  }
  busy.value = true
  const result = await model.updateAttribute(a, body, confirm)
  busy.value = false
  if (result.ok) {
    confirmOpen.value = false
    open.value = false
    emit('saved', result.data, false)
    return
  }
  if (result.kind === 'confirm') {
    // First ask, or the count moved since: show the count the server has now.
    affected.value = result.affected
    confirmOpen.value = true
    return
  }
  confirmOpen.value = false
  error.value = result.message
  if (result.kind === 'conflict') fill()
}
</script>

<template>
  <BaseDialog v-model:open="open" :title="title" width="lg" :persistent="busy || confirmOpen">
    <form :id="formId" class="flex flex-col gap-4" novalidate @submit.prevent="submit">
      <BaseInput
        v-model="draft.name"
        label="Name"
        :error="errors.name ?? ''"
        maxlength="200"
        autofocus
        data-attr-name
      />

      <AttributeTypePicker v-model="draft.type" :locked="!!attribute" :error="errors.type ?? ''" />
      <p v-if="attribute && configSummary(attribute, hubName)" class="m-0 text-ink2" data-config>
        {{ configSummary(attribute, hubName) }}
      </p>
      <p v-if="isTitle" class="m-0 text-secondary text-ink3" data-title-note>
        This is the hub's title attribute: items are named by it.
      </p>

      <!-- Settings for the chosen type. Only a select's options change after creation (D51). -->
      <template v-if="!attribute">
        <template v-if="draft.type === 'number'">
          <BaseSelect v-model="draft.numberFormat" label="Format" :options="numberFormats" />
          <BaseInput
            v-if="draft.numberFormat === 'currency'"
            v-model="draft.currency"
            label="Currency code"
            hint="Three letters, such as EUR or USD."
            :error="errors.currency ?? ''"
            maxlength="3"
            mono
          />
        </template>
        <ToggleSwitch
          v-else-if="draft.type === 'date'"
          v-model="draft.includeTime"
          label="Include a time"
          description="Off: a day only."
        />
        <ToggleSwitch
          v-else-if="draft.type === 'actor'"
          v-model="draft.multiple"
          label="Several people or agents"
          description="Off: one at most."
        />
        <BaseInput
          v-else-if="draft.type === 'auto_id'"
          v-model="draft.prefix"
          label="Prefix (optional)"
          hint="Shown before the number, such as BLD in BLD-12."
          :error="errors.prefix ?? ''"
          maxlength="10"
          mono
        />
        <template v-else-if="draft.type === 'relation'">
          <BaseSelect
            v-model="draft.targetHubId"
            label="Links to items in"
            :options="targetChoices"
            :hint="
              model.targets.value.state === 'loading'
                ? 'Loading the other hubs you can open.'
                : model.targets.value.state === 'error'
                  ? 'The other hubs could not load, so only this hub is offered.'
                  : 'Only hubs you can open are offered. The target cannot change later.'
            "
            :error="errors.targetHubId ?? ''"
            data-relation-target
          />
          <ToggleSwitch
            v-model="draft.multiple"
            label="Several items"
            description="Off: one linked item at most."
          />
        </template>
        <ToggleSwitch
          v-if="draft.type"
          v-model="draft.indexed"
          label="Filter and sort"
          description="Views can filter and sort by it. This cannot change later."
          data-attr-indexed
        />
      </template>
      <p v-else class="m-0 text-secondary text-ink3">
        Filter and sort: {{ attribute.indexed ? 'on' : 'off' }}. Only the name{{
          hasOptions ? ' and the options' : ''
        }}
        can change now.
      </p>

      <div v-if="hasOptions" class="flex flex-col gap-1">
        <OptionsEditor v-model="draft.options" />
        <span v-if="errors.options" class="text-secondary text-danger">{{ errors.options }}</span>
      </div>

      <FormNotice v-if="error" data-attr-dialog-error>{{ error }}</FormNotice>
    </form>
    <template #footer>
      <BaseButton :disabled="busy" @click="open = false">Cancel</BaseButton>
      <BaseButton variant="primary" type="submit" :form="formId" :disabled="busy">{{
        busy ? 'Saving…' : attribute ? 'Save attribute' : 'Create attribute'
      }}</BaseButton>
    </template>

    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="`Remove options from ${attribute?.name ?? 'this attribute'}?`"
      :message="strippedValuesMessage('options', attribute?.name ?? 'it', affected)"
      confirm-label="Remove options and save"
      :busy="busy"
      @confirm="saveExisting(affected)"
    />
  </BaseDialog>
</template>
