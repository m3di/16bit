<script setup lang="ts">
import type { HubGrantEntry, HubRole, Principal, Subject } from '@16bit/core'
import { computed, ref, watch } from 'vue'
import { asRequestError } from '../../api/client.ts'
import {
  BaseButton,
  BaseDialog,
  BaseSelect,
  FormNotice,
  type SettingsState,
} from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import { ROLE_LABELS } from '../workspace/members.ts'
import { HUB_ROLE_LABELS, newGrantRoles } from './access.ts'

// Give a person in the workspace access to this hub. Agents get theirs with their key.

const open = defineModel<boolean>('open', { default: false })

const { viewer, hubRole, members, grants, add } = defineProps<{
  viewer: Subject | null
  /** The reader's own effective role on this hub. */
  hubRole: HubRole
  members: Load<Principal[]>
  grants: readonly HubGrantEntry[]
  add: (person: Principal, hubRole: HubRole) => Promise<void>
}>()

const emit = defineEmits<{ added: [person: Principal, hubRole: HubRole]; retry: [] }>()

const personId = ref('')
const role = ref<string>('editor')
const busy = ref(false)
const error = ref('')

// People without a grant here, that the reader may give at least one role.
const candidates = computed(() => {
  if (members.state !== 'ready') return []
  const held = new Set(grants.map((g) => g.principalId))
  return members.data.filter((p) => !held.has(p.id) && newGrantRoles(viewer, hubRole, p).length > 0)
})
const person = computed(() => candidates.value.find((p) => p.id === personId.value) ?? null)
const roles = computed(() => (person.value ? newGrantRoles(viewer, hubRole, person.value) : []))

watch(open, (isOpen) => {
  if (!isOpen) return
  personId.value = candidates.value[0]?.id ?? ''
  busy.value = false
  error.value = ''
})
watch(
  candidates,
  (list) => {
    if (!list.some((p) => p.id === personId.value)) personId.value = list[0]?.id ?? ''
  },
  { immediate: true },
)
watch(
  roles,
  (list) => {
    if (!list.includes(role.value as HubRole)) {
      role.value = list.includes('editor') ? 'editor' : (list.at(-1) ?? '')
    }
  },
  { immediate: true },
)

const state = computed((): SettingsState => {
  if (members.state === 'loading') return 'loading'
  if (members.state === 'error') return members.error.isNoPermission ? 'no-permission' : 'error'
  return candidates.value.length === 0 ? 'empty' : 'ready'
})

const personOptions = computed(() =>
  candidates.value.map((p) => ({
    value: p.id,
    label: `${p.name} (${ROLE_LABELS[p.workspaceRole]})`,
  })),
)
const roleOptions = computed(() =>
  roles.value.map((r) => ({ value: r, label: HUB_ROLE_LABELS[r] })),
)
const capNote = computed(() =>
  person.value?.workspaceRole === 'viewer' || person.value?.workspaceRole === 'finance'
    ? `As a ${ROLE_LABELS[person.value.workspaceRole].toLowerCase()} of the workspace, they act as a viewer here whatever the role.`
    : '',
)

async function submit() {
  const p = person.value
  if (busy.value || !p || !roles.value.includes(role.value as HubRole)) return
  busy.value = true
  error.value = ''
  try {
    await add(p, role.value as HubRole)
    emit('added', p, role.value as HubRole)
    busy.value = false
    open.value = false
  } catch (thrown) {
    const e = asRequestError(thrown)
    error.value = e.isNoPermission
      ? 'Your role does not allow giving this access.'
      : e.isNotFound
        ? `${p.name} is no longer in this workspace, or this hub is gone.`
        : `${p.name} was not given access. ${e.message}`
    busy.value = false
  }
}
</script>

<template>
  <BaseDialog
    v-model:open="open"
    title="Add people"
    description="Give someone in this workspace access to this hub. Agents get access with an agent key."
    :persistent="busy"
    :state="state === 'empty' || state === 'ready' ? 'ready' : state"
    :state-title="
      state === 'loading'
        ? 'Loading people'
        : state === 'no-permission'
          ? 'You cannot see this workspace’s people'
          : 'The people could not be loaded'
    "
    :state-message="members.state === 'error' ? members.error.message : ''"
  >
    <template v-if="state === 'error'" #state-action>
      <BaseButton size="sm" @click="emit('retry')">Try again</BaseButton>
    </template>

    <div v-if="state === 'empty'" class="flex flex-col gap-4" data-add-empty>
      <p class="m-0 text-ink2">
        Everyone in this workspace you can add already has access. Invite people to the workspace
        first, from its members page.
      </p>
      <div class="flex justify-end border-t border-line pt-4">
        <BaseButton @click="open = false">Close</BaseButton>
      </div>
    </div>

    <form
      v-else
      class="flex flex-col gap-4"
      :aria-busy="busy ? 'true' : undefined"
      novalidate
      @submit.prevent="submit"
    >
      <BaseSelect
        v-model="personId"
        label="Person"
        :options="personOptions"
        :disabled="busy"
        autofocus
      />
      <BaseSelect
        v-model="role"
        label="Hub role"
        :options="roleOptions"
        :hint="capNote"
        :disabled="busy"
      />
      <FormNotice v-if="error">{{ error }}</FormNotice>
      <div class="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
        <BaseButton :disabled="busy" @click="open = false">Cancel</BaseButton>
        <BaseButton type="submit" variant="primary" :disabled="busy || !person">{{
          busy ? 'Adding' : 'Add to hub'
        }}</BaseButton>
      </div>
    </form>
  </BaseDialog>
</template>
