<script setup lang="ts">
import type { HubGrantEntry, HubRole, Principal, Subject } from '@16bit/core'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ActorChip,
  BaseButton,
  BaseSelect,
  ConfirmDialog,
  FormNotice,
  RowActionsMenu,
  SettingsSection,
  type RowAction,
  type SettingsState,
} from '../../ui/index.ts'
import { createCommitter } from '../workspace/members.ts'
import {
  ACCESS_HIDDEN,
  canListGrants,
  canRevokeGrant,
  cappedNote,
  grantRoleChoices,
  HUB_ROLE_LABELS,
  lockedGrantReason,
  sourceLabel,
} from './access.ts'
import AddAccessDialog from './AddAccessDialog.vue'
import type { HubAccess } from './useHubAccess.ts'

const { viewer, hubRole, hubName, access } = defineProps<{
  viewer: Subject | null
  /** The reader's own effective role on this hub. */
  hubRole: HubRole
  hubName: string
  access: HubAccess
}>()

const emit = defineEmits<{
  status: [text: string, focus: boolean]
  /** The reader changed their own grant: the hub must be read again. */
  selfChange: []
}>()

const router = useRouter()
const lists = computed(() => canListGrants(viewer, hubRole))

onMounted(() => {
  if (lists.value) void access.loadGrants()
})

const grants = computed(() => access.grants.value)
const rows = computed(() => (grants.value.state === 'ready' ? grants.value.data : []))
const selfId = computed(() => viewer?.id ?? null)

const state = computed((): SettingsState => {
  if (!lists.value) return 'no-permission'
  const g = grants.value
  if (g.state === 'loading') return 'loading'
  if (g.state === 'error') {
    if (g.error.isNotFound) return 'not-found'
    return g.error.isNoPermission ? 'no-permission' : 'error'
  }
  return g.data.length === 0 ? 'empty' : 'ready'
})
const stateTitle = computed(() => {
  switch (state.value) {
    case 'loading':
      return 'Loading who has access'
    case 'no-permission':
      return 'You cannot see who has access'
    case 'not-found':
      return 'This hub is not available'
    case 'error':
      return 'Who has access could not be loaded'
    case 'empty':
      return 'Nobody has access yet'
    default:
      return ''
  }
})
const stateMessage = computed(() => {
  switch (state.value) {
    case 'no-permission':
      return ACCESS_HIDDEN
    case 'not-found':
      return 'It may not exist, or it may not be shared with you.'
    case 'error':
      return grants.value.state === 'error' ? grants.value.error.message : ''
    case 'empty':
      return 'People and agent keys with access to this hub show here.'
    default:
      return ''
  }
})

const choices = (g: HubGrantEntry) => grantRoleChoices(viewer, hubRole, g)
const roleOptions = (g: HubGrantEntry) =>
  choices(g).map((r) => ({ value: r, label: HUB_ROLE_LABELS[r] }))
const canAdd = computed(
  () =>
    lists.value &&
    !!viewer &&
    // Anyone who may change a member's grant may add one.
    grantRoleChoices(viewer, hubRole, {
      principalId: '',
      kind: 'user',
      name: '',
      workspaceRole: 'member',
      hubRole: 'viewer',
    }).length > 1,
)

// A role choice shows at once and is sent after a short pause or when the select loses focus,
// so arrowing through a closed select sends one change, not one per key.
const drafts = ref(new Map<string, HubRole>())
const committer = createCommitter<HubRole>((id, role) => {
  void commitRole(id, role)
})
onBeforeUnmount(() => {
  committer.flushAll()
})
const shownRole = (g: HubGrantEntry) => drafts.value.get(g.principalId) ?? g.hubRole

function onRole(g: HubGrantEntry, value: string) {
  drafts.value.set(g.principalId, value as HubRole)
  committer.choose(g.principalId, value as HubRole)
}

async function commitRole(id: string, role: HubRole) {
  drafts.value.delete(id)
  const ok = await access.changeRole(id, role)
  if (ok && id === selfId.value) emit('selfChange')
}

function rowActions(g: HubGrantEntry): RowAction[] {
  if (!canRevokeGrant(viewer, hubRole, g)) return []
  return [
    {
      key: 'revoke',
      label: g.principalId === selfId.value ? 'Remove my access' : 'Revoke access',
      danger: true,
    },
  ]
}

// Revoking someone else's access is optimistic: it can be given back. Removing your own asks
// first, since the hub then disappears from your view.
const selfRevokeOpen = ref(false)
const selfRevokeBusy = ref(false)
const selfRevokeError = ref('')

async function onRowAction(g: HubGrantEntry, key: string) {
  if (key !== 'revoke') return
  if (g.principalId === selfId.value) {
    selfRevokeError.value = ''
    selfRevokeOpen.value = true
    return
  }
  const ok = await access.revoke(g.principalId)
  if (ok) emit('status', `Revoked ${g.name}'s access.`, true)
}

async function confirmSelfRevoke() {
  const id = selfId.value
  if (!id) return
  selfRevokeBusy.value = true
  const ok = await access.revoke(id)
  selfRevokeBusy.value = false
  if (ok) {
    selfRevokeOpen.value = false
    await router.push('/')
    return
  }
  selfRevokeError.value = access.notice.value ?? 'Your access was not removed.'
  access.dismissNotice()
}

const addOpen = ref(false)
function openAdd() {
  if (access.members.value.state !== 'ready') void access.loadMembers()
  addOpen.value = true
}
function onAdded(person: Principal, role: HubRole) {
  emit('status', `${person.name} now has ${HUB_ROLE_LABELS[role].toLowerCase()} access.`, false)
}
</script>

<template>
  <SettingsSection
    title="Access"
    :state="state"
    :state-title="stateTitle"
    :state-message="stateMessage"
    description="A workspace’s viewers and finance people act as viewers in every hub, whatever their hub role. Agent keys get access with their key and lose it when it is revoked."
    data-access-section
  >
    <template v-if="canAdd" #actions>
      <BaseButton data-add-access @click="openAdd">Add people</BaseButton>
    </template>
    <template v-if="state === 'error'" #state-action>
      <BaseButton size="sm" @click="access.loadGrants()">Try again</BaseButton>
    </template>

    <FormNotice v-if="access.notice.value" data-access-notice>
      {{ access.notice.value }}
      <template #action>
        <BaseButton size="sm" variant="quiet" @click="access.dismissNotice()">Dismiss</BaseButton>
      </template>
    </FormNotice>

    <div class="relative min-w-0 overflow-x-auto">
      <table class="w-full min-w-[480px] border-collapse text-left">
        <caption class="sr-only">
          Who has access to this hub, and their hub role
        </caption>
        <thead>
          <tr class="border-b border-line">
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Who</th>
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Hub role</th>
            <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">
              In the workspace
            </th>
            <th scope="col" class="h-8 w-10 text-caption font-normal text-ink3">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="g in rows"
            :key="g.principalId"
            class="border-b border-line"
            data-grant-row
            :data-principal-id="g.principalId"
          >
            <th scope="row" class="h-[38px] pr-3 font-normal">
              <span class="inline-flex min-w-0 items-center gap-2">
                <ActorChip
                  :actor="{
                    id: g.principalId,
                    name: g.name,
                    kind: g.kind === 'agent' ? 'agent' : 'person',
                  }"
                />
                <span v-if="g.principalId === selfId" class="text-secondary text-ink3">You</span>
              </span>
            </th>
            <td class="h-[38px] pr-3">
              <div v-if="choices(g).length > 1" class="w-36" :data-grant-role="g.principalId">
                <BaseSelect
                  :model-value="shownRole(g)"
                  :label="`Hub role for ${g.name}`"
                  label-hidden
                  size="sm"
                  :options="roleOptions(g)"
                  @update:model-value="onRole(g, $event)"
                  @blur="committer.flush(g.principalId)"
                />
              </div>
              <span
                v-else
                class="inline-flex flex-wrap items-baseline gap-x-2"
                data-grant-role-text
              >
                <span>{{ HUB_ROLE_LABELS[g.hubRole] }}</span>
                <span
                  v-if="lockedGrantReason(viewer, hubRole, g)"
                  class="text-secondary text-ink3"
                  >{{ lockedGrantReason(viewer, hubRole, g) }}</span
                >
              </span>
              <span v-if="cappedNote(g)" class="block text-secondary text-ink3" data-capped>{{
                cappedNote(g)
              }}</span>
            </td>
            <td class="h-[38px] pr-3 text-secondary text-ink2">{{ sourceLabel(g) }}</td>
            <td class="h-[38px] text-right">
              <RowActionsMenu
                :label="`Actions for ${g.name}`"
                :items="rowActions(g)"
                @select="onRowAction(g, $event)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </SettingsSection>

  <AddAccessDialog
    v-model:open="addOpen"
    :viewer="viewer"
    :hub-role="hubRole"
    :members="access.members.value"
    :grants="rows"
    :add="access.add"
    @added="onAdded"
    @retry="access.loadMembers()"
  />

  <ConfirmDialog
    v-model:open="selfRevokeOpen"
    :title="`Remove your access to ${hubName}?`"
    message="You will no longer see anything inside this hub. As a workspace owner or admin you can give yourself access again from the hub list."
    confirm-label="Remove my access"
    :busy="selfRevokeBusy"
    :error="selfRevokeError"
    @confirm="confirmSelfRevoke"
  />
</template>
