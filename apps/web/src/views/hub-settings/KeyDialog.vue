<script setup lang="ts">
import type { AgentHubRole, CreatedAgentKey } from '@16bit/core'
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { asRequestError } from '../../api/client.ts'
import { BaseButton, BaseDialog, BaseInput, BaseSelect, FormNotice } from '../../ui/index.ts'
import { shortDate } from '../workspace/members.ts'
import { HUB_ROLE_LABELS, KEY_LIFETIMES, keyExpiry } from './access.ts'

// Create an agent key, then show its secret once: the API keeps only its hash, so the secret
// cannot be shown again after this dialog closes.

const open = defineModel<boolean>('open', { default: false })

const { roles, hubName, create } = defineProps<{
  /** The roles the reader may give a key: at most their own hub role (`key.create`). */
  roles: readonly AgentHubRole[]
  hubName: string
  create: (input: {
    name: string
    hubRole: AgentHubRole
    expiresAt: string | null
  }) => Promise<CreatedAgentKey>
}>()

const emit = defineEmits<{ created: [key: CreatedAgentKey] }>()

const name = ref('')
const role = ref<string>('')
const lifetime = ref<string>('90')
const busy = ref(false)
const error = ref('')
const nameError = ref('')
const created = ref<CreatedAgentKey | null>(null)
const copied = ref<'idle' | 'done' | 'failed'>('idle')

watch(open, (isOpen) => {
  if (!isOpen) return
  name.value = ''
  role.value = roles.includes('viewer') ? 'viewer' : (roles[0] ?? '')
  lifetime.value = '90'
  busy.value = false
  error.value = ''
  nameError.value = ''
  created.value = null
  copied.value = 'idle'
})

const roleOptions = computed(() => roles.map((r) => ({ value: r, label: HUB_ROLE_LABELS[r] })))
const lifetimeOptions = KEY_LIFETIMES.map((l) => ({ value: l.value, label: l.label }))
const roleHint = computed(() =>
  roles.length < 3 ? 'A key can have at most your own role on this hub.' : '',
)

const secretField = useTemplateRef<HTMLElement>('secretField')

async function submit() {
  if (busy.value) return
  const trimmed = name.value.trim()
  nameError.value = trimmed ? '' : 'Name the key, such as the agent that will use it.'
  if (nameError.value || !roles.includes(role.value as AgentHubRole)) return
  busy.value = true
  error.value = ''
  try {
    created.value = await create({
      name: trimmed,
      hubRole: role.value as AgentHubRole,
      expiresAt: keyExpiry(lifetime.value),
    })
    emit('created', created.value)
    await nextTick()
    // The secret is what the reader came for: select it, ready to copy.
    const input = secretField.value?.querySelector('input')
    input?.focus()
    input?.select()
  } catch (thrown) {
    const e = asRequestError(thrown)
    error.value = e.isNoPermission
      ? 'Your role does not allow creating this key.'
      : `The key was not created. ${e.message}`
  } finally {
    busy.value = false
  }
}

async function copy() {
  if (!created.value) return
  try {
    await navigator.clipboard.writeText(created.value.secret)
    copied.value = 'done'
  } catch {
    copied.value = 'failed'
  }
}
</script>

<template>
  <BaseDialog
    v-model:open="open"
    :title="created ? 'Agent key secret' : 'New agent key'"
    :description="
      created
        ? 'Copy the secret now. It is shown only once and cannot be read again. Choose Done when you have it.'
        : `The key acts in ${hubName} only, as its own principal, with the role you choose.`
    "
    :persistent="busy || created !== null"
  >
    <!-- While the secret shows, Escape, Close and the backdrop do nothing: only Done closes. -->
    <div v-if="created" class="flex flex-col gap-4" data-key-created>
      <div ref="secretField">
        <BaseInput
          :model-value="created.secret"
          label="Secret"
          readonly
          mono
          spellcheck="false"
          autocomplete="off"
          :hint="`${created.key.name}, ${HUB_ROLE_LABELS[created.key.hubRole].toLowerCase()}. ${
            created.key.expiresAt
              ? `Expires ${shortDate(created.key.expiresAt)}.`
              : 'Never expires.'
          } Send it as Authorization: Bearer <secret>.`"
        />
      </div>
      <FormNotice v-if="copied === 'done'" tone="info">The secret is copied.</FormNotice>
      <FormNotice v-else-if="copied === 'failed'"
        >The secret could not be copied. Select it and copy it yourself.</FormNotice
      >
      <div class="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
        <BaseButton @click="open = false">Done</BaseButton>
        <BaseButton variant="primary" @click="copy">Copy secret</BaseButton>
      </div>
    </div>

    <form
      v-else
      class="flex flex-col gap-4"
      :aria-busy="busy ? 'true' : undefined"
      novalidate
      @submit.prevent="submit"
    >
      <BaseInput
        v-model="name"
        label="Name"
        maxlength="200"
        :error="nameError"
        :disabled="busy"
        autofocus
      />
      <BaseSelect
        v-model="role"
        label="Hub role"
        :options="roleOptions"
        :hint="roleHint"
        :disabled="busy"
      />
      <BaseSelect v-model="lifetime" label="Expires" :options="lifetimeOptions" :disabled="busy" />
      <FormNotice v-if="error">{{ error }}</FormNotice>
      <div class="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
        <BaseButton :disabled="busy" @click="open = false">Cancel</BaseButton>
        <BaseButton type="submit" variant="primary" :disabled="busy">{{
          busy ? 'Creating' : 'Create key'
        }}</BaseButton>
      </div>
    </form>
  </BaseDialog>
</template>
