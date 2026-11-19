<script setup lang="ts">
import type { HubDescription, PaletteColor } from '@16bit/core'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  BaseButton,
  BaseInput,
  BaseSelect,
  FormNotice,
  PalettePicker,
  SettingsSection,
} from '../../ui/index.ts'
import { createCommitter } from '../workspace/members.ts'
import { GENERAL_READ_ONLY, itemTotal, titleChoices } from './access.ts'
import type { HubSettings } from './useHubSettings.ts'

const { description, manages, model } = defineProps<{
  description: HubDescription
  /** `hub.rename`: otherwise the values show read-only, with the reason. */
  manages: boolean
  model: HubSettings
}>()

const hub = computed(() => description.hub)

// The name is sent when the field is left or Enter is pressed, not on every key.
const name = ref(hub.value.name)
const nameError = ref('')
watch(
  () => hub.value.name,
  (saved) => {
    name.value = saved
    nameError.value = ''
  },
)

function commitName() {
  const next = name.value.trim()
  if (!next) {
    nameError.value = 'Name the hub.'
    return
  }
  if (next.length > 200) {
    nameError.value = 'Use at most 200 characters.'
    return
  }
  nameError.value = ''
  if (next === hub.value.name) {
    name.value = next
    return
  }
  void model.updateHub({ name: next })
}

// Arrow keys move through the colours and a closed select fires on every arrow key, so both
// are sent after a short pause: one change, not one per key.
const committer = createCommitter<string>((field, value) => {
  if (field === 'color') {
    if (value !== hub.value.color) void model.updateHub({ color: value as PaletteColor })
  } else {
    const id = value === '' ? null : value
    if (id !== hub.value.titleAttributeId) void model.updateHub({ titleAttributeId: id })
  }
}, 500)
onBeforeUnmount(() => {
  committer.flushAll()
})

const color = ref<PaletteColor | null>(hub.value.color)
watch(
  () => hub.value.color,
  (saved) => {
    color.value = saved
  },
)
function onColor(value: PaletteColor | null) {
  if (!value) return
  color.value = value
  committer.choose('color', value)
}

const title = ref(hub.value.titleAttributeId ?? '')
watch(
  () => hub.value.titleAttributeId,
  (saved) => {
    title.value = saved ?? ''
  },
)
function onTitle(value: string) {
  title.value = value
  committer.choose('title', value)
}

const choices = computed(() => titleChoices(description))
const titleOptions = computed(() => [
  { value: '', label: 'None: items show their ID only' },
  ...choices.value.map((a) => ({ value: a.id, label: a.name })),
])
const titleName = computed(
  () => description.attributes.find((a) => a.id === hub.value.titleAttributeId)?.name ?? '',
)
const titleHint = computed(() =>
  choices.value.length === 0
    ? 'The hub has no text attribute yet. Add one under Attributes to title its items.'
    : 'Items are titled with this text attribute in links, the relation picker and their page.',
)

// The prefix is chosen when the hub is created; the hub update has no field for it.
const prefixNote = computed(
  () =>
    `Items are numbered ${hub.value.idPrefix}-1, ${hub.value.idPrefix}-2 and on. It is set when the hub is created and does not change.`,
)

const saveState = computed(() =>
  model.hubSaving.value > 0 ? 'Saving' : model.hubNotice.value ? '' : 'All changes saved',
)
</script>

<template>
  <SettingsSection
    title="General"
    :description="manages ? '' : GENERAL_READ_ONLY"
    data-general-section
  >
    <template v-if="manages" #actions>
      <span class="text-secondary text-ink3" aria-live="polite" data-save-state>{{
        saveState
      }}</span>
    </template>

    <FormNotice v-if="model.hubNotice.value" data-hub-notice>
      {{ model.hubNotice.value }}
      <template #action>
        <BaseButton size="sm" variant="quiet" @click="model.dismissHubNotice()">Dismiss</BaseButton>
      </template>
    </FormNotice>

    <div class="flex max-w-[560px] flex-col gap-4">
      <template v-if="manages">
        <BaseInput
          v-model="name"
          label="Name"
          :error="nameError"
          :hint="itemTotal(hub.itemCount)"
          maxlength="200"
          data-hub-name
          @change="commitName"
          @keydown.enter.prevent="commitName"
        />
        <PalettePicker :model-value="color" label="Colour" @update:model-value="onColor" />
        <BaseSelect
          :model-value="title"
          label="Item title"
          :options="titleOptions"
          :hint="titleHint"
          data-title-attribute
          @update:model-value="onTitle"
          @blur="committer.flush('title')"
        />
      </template>

      <div v-else class="flex flex-col gap-4" data-general-read-only>
        <div class="flex flex-col gap-1">
          <span class="text-secondary text-ink3">Name</span>
          <span>{{ hub.name }}</span>
          <span class="text-secondary text-ink3">{{ itemTotal(hub.itemCount) }}</span>
        </div>
        <PalettePicker :model-value="hub.color" label="Colour" state="no-permission" />
        <div class="flex flex-col gap-1">
          <span class="text-secondary text-ink3">Item title</span>
          <span>{{ titleName || 'None: items show their ID only' }}</span>
        </div>
      </div>

      <!-- Read-only for everyone: the hub update has no field for it. -->
      <dl class="m-0 flex flex-col gap-1" data-hub-prefix>
        <dt class="text-secondary text-ink3">ID prefix</dt>
        <dd class="m-0 font-mono text-secondary text-ink">{{ hub.idPrefix }}</dd>
        <dd class="m-0 text-secondary text-ink3">{{ prefixNote }}</dd>
      </dl>
    </div>
  </SettingsSection>
</template>
