<script setup lang="ts">
import {
  INVITE_DEFAULT_DAYS,
  INVITE_MAX_DAYS,
  type CreatedInvite,
  type WorkspaceRole,
} from '@16bit/core'
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { asRequestError } from '../../api/client.ts'
import { BaseButton, BaseDialog, BaseInput, BaseSelect, FormNotice } from '../../ui/index.ts'
import { ROLE_LABELS, shortDate } from './members.ts'

// Create an invite, then show its link once: the API keeps only the token's hash, so the link
// cannot be shown again after this dialog closes.

const open = defineModel<boolean>('open', { default: false })

const { roles, create, origin } = defineProps<{
  /** The roles the reader may invite as, from `can(member.invite)`. */
  roles: readonly WorkspaceRole[]
  create: (role: WorkspaceRole, days: number) => Promise<CreatedInvite>
  /** The page's origin, for the link. */
  origin: string
}>()

const role = ref<string>('member')
const days = ref(String(INVITE_DEFAULT_DAYS))
const busy = ref(false)
const error = ref('')
const created = ref<CreatedInvite | null>(null)
const copied = ref<'idle' | 'done' | 'failed'>('idle')

watch(open, (isOpen) => {
  if (!isOpen) return
  role.value = roles.includes('member') ? 'member' : (roles[0] ?? '')
  days.value = String(INVITE_DEFAULT_DAYS)
  busy.value = false
  error.value = ''
  created.value = null
  copied.value = 'idle'
})

const roleOptions = computed(() => roles.map((r) => ({ value: r, label: ROLE_LABELS[r] })))

const daysError = computed(() => {
  const n = Number(days.value)
  return Number.isInteger(n) && n >= 1 && n <= INVITE_MAX_DAYS
    ? ''
    : `Choose a whole number of days from 1 to ${String(INVITE_MAX_DAYS)}.`
})
const showDaysError = ref(false)

const link = computed(() =>
  created.value ? `${origin}/invite/${encodeURIComponent(created.value.token)}` : '',
)

const linkField = useTemplateRef<HTMLElement>('linkField')

async function submit() {
  if (busy.value) return
  showDaysError.value = true
  if (daysError.value || !roles.includes(role.value as WorkspaceRole)) return
  busy.value = true
  error.value = ''
  try {
    created.value = await create(role.value as WorkspaceRole, Number(days.value))
    await nextTick()
    // The link is what the reader came for: select it, ready to copy.
    const input = linkField.value?.querySelector('input')
    input?.focus()
    input?.select()
  } catch (thrown) {
    const e = asRequestError(thrown)
    error.value = e.isNoPermission
      ? 'Your role does not allow inviting people as this role.'
      : `The invite was not created. ${e.message}`
  } finally {
    busy.value = false
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(link.value)
    copied.value = 'done'
  } catch {
    copied.value = 'failed'
  }
}
</script>

<template>
  <BaseDialog
    v-model:open="open"
    :title="created ? 'Invite link' : 'Invite people'"
    :description="
      created
        ? 'Copy the link now. It is shown only once, and one person can use it.'
        : 'Anyone with the link can join this workspace with the role you choose.'
    "
    :persistent="busy"
  >
    <div v-if="created" class="flex flex-col gap-4" data-invite-created>
      <div ref="linkField">
        <BaseInput
          :model-value="link"
          label="Invite link"
          readonly
          mono
          spellcheck="false"
          :hint="`Joins as ${ROLE_LABELS[created.invite.workspaceRole]}. Expires ${shortDate(created.invite.expiresAt)}.`"
        />
      </div>
      <FormNotice v-if="copied === 'done'" tone="info">The link is copied.</FormNotice>
      <FormNotice v-else-if="copied === 'failed'"
        >The link could not be copied. Select it and copy it yourself.</FormNotice
      >
      <div class="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
        <BaseButton @click="open = false">Done</BaseButton>
        <BaseButton variant="primary" @click="copy">Copy link</BaseButton>
      </div>
    </div>

    <form
      v-else
      class="flex flex-col gap-4"
      :aria-busy="busy ? 'true' : undefined"
      novalidate
      @submit.prevent="submit"
    >
      <BaseSelect v-model="role" label="Role" :options="roleOptions" :disabled="busy" autofocus />
      <BaseInput
        v-model="days"
        type="number"
        label="Expires after (days)"
        :min="1"
        :max="INVITE_MAX_DAYS"
        inputmode="numeric"
        :disabled="busy"
        :error="showDaysError ? daysError : ''"
      />
      <FormNotice v-if="error">{{ error }}</FormNotice>
      <div class="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
        <BaseButton :disabled="busy" @click="open = false">Cancel</BaseButton>
        <BaseButton type="submit" variant="primary" :disabled="busy">{{
          busy ? 'Creating' : 'Create invite link'
        }}</BaseButton>
      </div>
    </form>
  </BaseDialog>
</template>
