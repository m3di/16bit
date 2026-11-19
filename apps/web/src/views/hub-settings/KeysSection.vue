<script setup lang="ts">
import type { AgentKey, CreatedAgentKey, HubRole, Subject } from '@16bit/core'
import { computed, onMounted, ref } from 'vue'
import { asRequestError } from '../../api/client.ts'
import {
  ActorChip,
  BaseButton,
  ConfirmDialog,
  SettingsSection,
  StatusDot,
  type SettingsState,
} from '../../ui/index.ts'
import { shortDate } from '../workspace/members.ts'
import {
  canListKeys,
  canRevokeKey,
  HUB_ROLE_LABELS,
  KEYS_HIDDEN,
  keyRoleChoices,
  keyStatus,
  type KeyStatus,
} from './access.ts'
import KeyDialog from './KeyDialog.vue'
import type { HubAccess } from './useHubAccess.ts'

const { viewer, hubRole, hubName, access } = defineProps<{
  viewer: Subject | null
  hubRole: HubRole
  hubName: string
  access: HubAccess
}>()

const emit = defineEmits<{ status: [text: string, focus: boolean] }>()

const lists = computed(() => canListKeys(viewer, hubRole))
const roles = computed(() => keyRoleChoices(viewer, hubRole))
const revokes = computed(() => canRevokeKey(viewer, hubRole))

onMounted(() => {
  if (!lists.value) return
  void access.loadKeys()
  // Only for the creators' names; without it they show as short IDs.
  if (access.members.value.state !== 'ready') void access.loadMembers()
})

const keys = computed(() => access.keys.value)
const rows = computed(() => (keys.value.state === 'ready' ? keys.value.data : []))

const state = computed((): SettingsState => {
  if (!lists.value) return 'no-permission'
  const k = keys.value
  if (k.state === 'loading') return 'loading'
  if (k.state === 'error') {
    if (k.error.isNotFound) return 'not-found'
    return k.error.isNoPermission ? 'no-permission' : 'error'
  }
  return k.data.length === 0 ? 'empty' : 'ready'
})
const stateTitle = computed(
  () =>
    ({
      loading: 'Loading agent keys',
      'no-permission': 'You cannot see this hub’s agent keys',
      'not-found': 'This hub is not available',
      error: 'The agent keys could not be loaded',
      empty: 'No agent keys yet',
      ready: '',
    })[state.value],
)
const stateMessage = computed(() => {
  switch (state.value) {
    case 'no-permission':
      return KEYS_HIDDEN
    case 'not-found':
      return 'It may not exist, or it may not be shared with you.'
    case 'error':
      return keys.value.state === 'error' ? keys.value.error.message : ''
    case 'empty':
      return 'An agent key lets a program read and change this hub’s items as its own principal.'
    default:
      return ''
  }
})

const creatorOf = (key: AgentKey) => {
  const m = access.members.value
  const p = m.state === 'ready' ? m.data.find((x) => x.id === key.createdBy) : undefined
  return p
    ? { id: p.id, name: p.name, kind: 'person' as const }
    : { id: key.createdBy, kind: 'unknown' as const }
}

const STATUS: Record<KeyStatus, { label: string; tone: 'success' | 'neutral' | 'danger' }> = {
  active: { label: 'Active', tone: 'success' },
  expired: { label: 'Expired', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'danger' },
}

const createOpen = ref(false)
function onCreated(created: CreatedAgentKey) {
  emit('status', `Created the key ${created.key.name}.`, false)
}

// Revoking cannot be undone, so it asks first and waits for the answer in its dialog.
const revoking = ref<AgentKey | null>(null)
const revokeOpen = ref(false)
const revokeBusy = ref(false)
const revokeError = ref('')

function startRevoke(key: AgentKey) {
  revoking.value = key
  revokeError.value = ''
  revokeOpen.value = true
}

async function confirmRevoke() {
  const key = revoking.value
  if (!key) return
  revokeBusy.value = true
  revokeError.value = ''
  try {
    await access.revokeKey(key.id)
    revokeBusy.value = false
    revokeOpen.value = false
    // The Revoke button is gone; focus moves to the page's status line.
    emit('status', `Revoked the key ${key.name}. Programs using it are refused from now on.`, true)
  } catch (thrown) {
    const e = asRequestError(thrown)
    revokeError.value = e.isNoPermission
      ? 'Your role does not allow revoking this key.'
      : e.isNotFound
        ? 'This key is no longer available.'
        : `The key was not revoked. ${e.message}`
    revokeBusy.value = false
  }
}
</script>

<template>
  <SettingsSection
    title="Agent keys"
    :state="state"
    :state-title="stateTitle"
    :state-message="stateMessage"
    description="A key acts in this hub only, with at most its creator’s role. Its secret is shown once, when it is made. Revoke a key you no longer trust and make a new one."
    data-keys-section
  >
    <template v-if="lists && roles.length" #actions>
      <BaseButton data-new-key @click="createOpen = true">New agent key</BaseButton>
    </template>
    <template v-if="state === 'error'" #state-action>
      <BaseButton size="sm" @click="access.loadKeys()">Try again</BaseButton>
    </template>
    <!-- The empty state hides the section's actions, so it offers the first key itself. -->
    <template v-else-if="state === 'empty' && roles.length" #state-action>
      <BaseButton size="sm" data-new-key @click="createOpen = true">New agent key</BaseButton>
    </template>

    <div class="relative min-w-0 overflow-x-auto">
      <table class="w-full min-w-[640px] border-collapse text-left">
        <caption class="sr-only">
          Agent keys of this hub, newest first
        </caption>
        <thead>
          <tr class="border-b border-line">
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Key</th>
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Hub role</th>
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Created by</th>
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Created</th>
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Expires</th>
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Status</th>
            <th scope="col" class="h-8 text-caption font-normal text-ink3">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="key in rows"
            :key="key.id"
            class="border-b border-line"
            data-key-row
            :data-key-id="key.id"
          >
            <th scope="row" class="h-[38px] pr-3 font-normal">
              <ActorChip :actor="{ id: key.id, name: key.name, kind: 'agent' }" />
            </th>
            <td class="h-[38px] pr-3">{{ HUB_ROLE_LABELS[key.hubRole] }}</td>
            <td class="h-[38px] pr-3"><ActorChip :actor="creatorOf(key)" /></td>
            <td class="h-[38px] pr-3 text-secondary text-ink2">{{ shortDate(key.createdAt) }}</td>
            <td class="h-[38px] pr-3 text-secondary text-ink2">
              {{ key.expiresAt ? shortDate(key.expiresAt) : 'Never' }}
            </td>
            <td class="h-[38px] pr-3">
              <StatusDot
                :label="STATUS[keyStatus(key)].label"
                :tone="STATUS[keyStatus(key)].tone"
              />
            </td>
            <td class="h-[38px] text-right">
              <BaseButton
                v-if="revokes && keyStatus(key) !== 'revoked'"
                size="sm"
                danger
                data-revoke-key
                @click="startRevoke(key)"
                >Revoke<span class="sr-only"> {{ key.name }}</span></BaseButton
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </SettingsSection>

  <KeyDialog
    v-model:open="createOpen"
    :roles="roles"
    :hub-name="hubName"
    :create="access.createKey"
    @created="onCreated"
  />

  <ConfirmDialog
    v-model:open="revokeOpen"
    :title="`Revoke ${revoking?.name ?? ''}?`"
    message="Programs using this key are refused from then on. This cannot be undone; make a new key if one is needed again."
    confirm-label="Revoke key"
    :busy="revokeBusy"
    :error="revokeError"
    @confirm="confirmRevoke"
  />
</template>
