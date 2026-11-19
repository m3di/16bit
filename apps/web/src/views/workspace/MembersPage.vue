<script setup lang="ts">
import type { Invite, Me, Principal, WorkspaceRole } from '@16bit/core'
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef } from 'vue'
import { useRouter } from 'vue-router'
import { asRequestError } from '../../api/client.ts'
import {
  ActorChip,
  BaseButton,
  BaseSelect,
  ConfirmDialog,
  FormNotice,
  RowActionsMenu,
  SettingsLayout,
  SettingsSection,
  type RowAction,
  type SettingsState,
} from '../../ui/index.ts'
import type { Load } from '../home/useDashboard.ts'
import InviteDialog from './InviteDialog.vue'
import {
  canManage,
  canRevokeInvite,
  createCommitter,
  inviteRoles,
  lockedReason,
  nextRevokeFocus,
  ownerCount,
  peopleSummary,
  removeState,
  ROLE_LABELS,
  roleChoices,
  shortDate,
  viewerSummary,
} from './members.ts'
import type { WorkspaceMembers } from './useWorkspaceMembers.ts'

const { workspaceId, model, me, origin } = defineProps<{
  workspaceId: string
  model: WorkspaceMembers
  /** The session, for who the reader is here. */
  me: Load<Me | null>
  /** For invite links: the app's own origin. */
  origin: string
}>()

const router = useRouter()

const members = computed(() => model.members.value)
const invites = computed(() => model.invites.value)
const viewer = computed(() => model.viewer.value)
const membership = computed(() => model.membership.value)

const pageState = computed((): SettingsState => {
  if (me.state === 'loading') return 'loading'
  if (me.state === 'error') return 'error'
  if (me.data?.kind === 'agent') return 'no-permission'
  const m = members.value
  if (m.state === 'loading') return 'loading'
  if (m.state === 'error') {
    if (m.error.isNotFound) return 'not-found'
    if (m.error.isNoPermission) return 'no-permission'
    return 'error'
  }
  return 'ready'
})

const stateText = computed(() => {
  switch (pageState.value) {
    case 'not-found':
      return {
        title: 'This workspace is not available',
        message: 'It may not exist, or you may not belong to it.',
      }
    case 'no-permission':
      return {
        title: 'You do not have access to this',
        message:
          me.state === 'ready' && me.data?.kind === 'agent'
            ? 'Agent keys cannot see a workspace’s members.'
            : 'Your role does not let you see this workspace’s members.',
      }
    case 'error':
      return {
        title: 'The members could not be loaded',
        message:
          me.state === 'error'
            ? me.error.message
            : members.value.state === 'error'
              ? members.value.error.message
              : '',
      }
    default:
      return { title: '', message: '' }
  }
})

const workspaceName = computed(() => membership.value?.workspace.name ?? '')
const trail = computed(() =>
  // A workspace the reader can't open answers 404: its name is not shown.
  pageState.value === 'not-found' || !workspaceName.value
    ? ['Workspace settings']
    : [workspaceName.value, 'Workspace settings'],
)
const sections = computed(() => [
  {
    key: 'members',
    label: 'Members and roles',
    to: { name: 'workspace-members', params: { workspaceId } },
  },
])

const people = computed(() => (members.value.state === 'ready' ? members.value.data : []))
const owners = computed(() => ownerCount(people.value))
const manages = computed(() => canManage(viewer.value))
const roles = computed(() => inviteRoles(viewer.value))
const selfId = computed(() => membership.value?.principalId ?? null)

const pendingCount = computed(() =>
  invites.value.state === 'ready' ? invites.value.data.length : null,
)
const summary = computed(() => peopleSummary(people.value.length, pendingCount.value))

const roleOptions = (p: Principal) =>
  roleChoices(viewer.value, p, owners.value).map((r) => ({ value: r, label: ROLE_LABELS[r] }))

function rowActions(p: Principal): RowAction[] {
  const state = removeState(viewer.value, p, owners.value)
  if (!state) return []
  const label = p.id === selfId.value ? 'Leave workspace' : 'Remove from workspace'
  return state.kind === 'allowed'
    ? [{ key: 'remove', label, danger: true }]
    : [{ key: 'remove', label, danger: true, disabled: true, reason: state.reason }]
}

// A role choice shows at once and is sent after a short pause or when the select loses focus,
// so arrowing through a closed select sends one change, not one per key.
const drafts = ref(new Map<string, WorkspaceRole>())
const committer = createCommitter<WorkspaceRole>((id, role) => {
  commitRole(id, role)
})
onBeforeUnmount(() => {
  committer.flushAll()
})

const shownRole = (p: Principal) => drafts.value.get(p.id) ?? p.workspaceRole

function onRole(p: Principal, value: string) {
  drafts.value.set(p.id, value as WorkspaceRole)
  committer.choose(p.id, value as WorkspaceRole)
}

function commitRole(id: string, role: WorkspaceRole) {
  const current = people.value.find((p) => p.id === id)?.workspaceRole
  if (role === current) {
    drafts.value.delete(id)
    return
  }
  if (id === selfId.value) {
    // Changes to your own role ask first: there is no way back without another owner or admin.
    // The draft stays on screen while the question is open.
    selfChange.value = role
    selfChangeOpen.value = true
    return
  }
  drafts.value.delete(id)
  void model.changeRole(id, role)
}

const selfChange = ref<WorkspaceRole | null>(null)
const selfChangeOpen = ref(false)

function confirmSelfChange() {
  const role = selfChange.value
  const id = selfId.value
  selfChange.value = null
  selfChangeOpen.value = false
  if (!role || !id) return
  drafts.value.delete(id)
  void model.changeRole(id, role)
}

async function onSelfChangeOpen(open: boolean) {
  if (open || selfChange.value === null) return
  // Cancelled: only this select goes back to the saved role, and keeps focus.
  const id = selfId.value
  selfChange.value = null
  if (!id) return
  committer.cancel(id)
  drafts.value.delete(id)
  await nextTick()
  roleSelect(id)?.focus()
}

const peopleList = useTemplateRef<HTMLElement>('peopleList')
const roleSelect = (id: string) =>
  [...(peopleList.value?.querySelectorAll<HTMLElement>('[data-role-select]') ?? [])]
    .find((el) => el.dataset['roleSelect'] === id)
    ?.querySelector('select') ?? null

const status = ref('')
const statusEl = useTemplateRef<HTMLElement>('statusEl')

async function announce(text: string) {
  status.value = text
  await nextTick()
  statusEl.value?.focus()
}

// Removing a member is confirmed, and the dialog waits for the answer.
const removing = ref<Principal | null>(null)
const removeOpen = ref(false)
const removeBusy = ref(false)
const removeError = ref('')

function onRowAction(p: Principal, key: string) {
  if (key !== 'remove') return
  removing.value = p
  removeError.value = ''
  removeOpen.value = true
}

async function confirmRemove() {
  const target = removing.value
  if (!target) return
  removeBusy.value = true
  removeError.value = ''
  try {
    const { self } = await model.remove(target.id)
    removeBusy.value = false
    removeOpen.value = false
    if (self) {
      await router.push('/')
      return
    }
    await announce(`${target.name} was removed from the workspace.`)
  } catch (thrown) {
    const e = asRequestError(thrown)
    removeError.value = e.isNoPermission
      ? 'Your role does not allow removing this person.'
      : `${target.name} was not removed. ${e.message}`
    removeBusy.value = false
  }
}

const removeIsSelf = computed(() => removing.value?.id === selfId.value)
const removeMessage = computed(() =>
  removeIsSelf.value
    ? 'You lose access to this workspace and every hub in it. Someone else must invite you again.'
    : 'They lose access to every hub in this workspace, and the invite links they created stop working. Agent keys they created stay until revoked.',
)

const inviteOpen = ref(false)

const creatorOf = (invite: Invite) => {
  const p = people.value.find((x) => x.id === invite.createdBy)
  return p
    ? { id: p.id, name: p.name, kind: 'person' as const }
    : { id: invite.createdBy, kind: 'unknown' as const }
}

const inviteList = useTemplateRef<HTMLElement>('inviteList')
const inviteButton = useTemplateRef<HTMLElement>('inviteButton')

async function revoke(invite: Invite) {
  const rows =
    invites.value.state === 'ready'
      ? invites.value.data.map((i) => ({
          id: i.id,
          revocable: canRevokeInvite(viewer.value, i.workspaceRole),
        }))
      : []
  const nextId = nextRevokeFocus(rows, invite.id)
  const done = model.revokeInvite(invite.id)
  // The row is gone at once: focus moves to the next Revoke button on the page, skipping rows
  // without one, so Enter never revokes an invite the reader did not pick.
  await nextTick()
  const next = [...(inviteList.value?.querySelectorAll<HTMLElement>('[data-invite-id]') ?? [])]
    .find((row) => row.dataset['inviteId'] === nextId)
    ?.querySelector<HTMLElement>('[data-revoke]')
  if (next) next.focus()
  else inviteButton.value?.querySelector('button')?.focus()
  await done
}

const inviteSectionState = computed((): SettingsState => {
  const i = invites.value
  if (i.state === 'loading') return 'loading'
  if (i.state === 'error') return i.error.isNoPermission ? 'no-permission' : 'error'
  if (i.state === 'ready' && i.data.length === 0) return 'empty'
  return 'ready'
})
</script>

<template>
  <SettingsLayout
    :trail="trail"
    :back="{ label: 'Back to hubs', to: '/' }"
    nav-label="Workspace settings"
    :sections="sections"
    current="members"
    title="Members and roles"
    :description="pageState === 'ready' ? viewerSummary(viewer?.workspaceRole ?? null) : ''"
    :state="pageState"
    :state-title="stateText.title"
    :state-message="stateText.message"
  >
    <template #actions>
      <span v-if="roles.length" ref="inviteButton">
        <BaseButton variant="primary" @click="inviteOpen = true">Invite people</BaseButton>
      </span>
    </template>
    <template v-if="pageState === 'error'" #state-action>
      <BaseButton size="sm" @click="model.load()">Try again</BaseButton>
    </template>

    <FormNotice v-if="model.notice.value" data-members-notice>
      {{ model.notice.value }}
      <template #action>
        <BaseButton size="sm" variant="quiet" @click="model.dismissNotice()">Dismiss</BaseButton>
      </template>
    </FormNotice>
    <p
      v-if="status"
      ref="statusEl"
      tabindex="-1"
      role="status"
      class="m-0 text-secondary text-ink2 outline-none"
      data-members-status
    >
      {{ status }}
    </p>

    <SettingsSection
      title="People"
      :state="people.length ? 'ready' : 'empty'"
      state-title="No people yet"
      state-message="People who join this workspace show here."
    >
      <template #actions>
        <span class="text-secondary text-ink3" data-people-summary>{{ summary }}</span>
      </template>
      <div ref="peopleList" class="relative min-w-0 overflow-x-auto">
        <table class="w-full border-collapse text-left">
          <caption class="sr-only">
            People in this workspace and their roles
          </caption>
          <thead>
            <tr class="border-b border-line">
              <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Name</th>
              <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Role</th>
              <th v-if="manages" scope="col" class="h-8 w-10 text-caption font-normal text-ink3">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in people" :key="p.id" class="border-b border-line" data-member-row>
              <th scope="row" class="h-[38px] pr-3 font-normal">
                <span class="inline-flex min-w-0 items-center gap-2">
                  <ActorChip :actor="{ id: p.id, name: p.name, kind: 'person' }" />
                  <span v-if="p.id === selfId" class="text-secondary text-ink3">You</span>
                </span>
              </th>
              <td class="h-[38px] pr-3">
                <div v-if="roleOptions(p).length > 1" class="w-36" :data-role-select="p.id">
                  <BaseSelect
                    :model-value="shownRole(p)"
                    :label="`Role for ${p.name}`"
                    label-hidden
                    size="sm"
                    :options="roleOptions(p)"
                    @update:model-value="onRole(p, $event)"
                    @blur="committer.flush(p.id)"
                  />
                </div>
                <span v-else class="inline-flex flex-wrap items-baseline gap-x-2" data-role-text>
                  <span>{{ ROLE_LABELS[p.workspaceRole] }}</span>
                  <span v-if="lockedReason(viewer, p, owners)" class="text-secondary text-ink3">{{
                    lockedReason(viewer, p, owners)
                  }}</span>
                </span>
              </td>
              <td v-if="manages" class="h-[38px] text-right">
                <RowActionsMenu
                  :label="`Actions for ${p.name}`"
                  :items="rowActions(p)"
                  @select="onRowAction(p, $event)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </SettingsSection>

    <SettingsSection
      v-if="invites.state !== 'hidden'"
      title="Pending invites"
      :state="inviteSectionState"
      :state-title="
        inviteSectionState === 'empty'
          ? 'No pending invites'
          : inviteSectionState === 'error'
            ? 'The invites could not be loaded'
            : ''
      "
      :state-message="
        inviteSectionState === 'empty'
          ? 'Invite links show here until they are used, revoked, or expire.'
          : invites.state === 'error'
            ? invites.error.isNoPermission
              ? 'Only owners and admins see pending invites.'
              : invites.error.message
            : ''
      "
      description="An invite link is shown once, when it is made. Revoke one you no longer trust and make a new one."
    >
      <template v-if="inviteSectionState === 'error'" #state-action>
        <BaseButton size="sm" @click="model.reloadInvites()">Try again</BaseButton>
      </template>
      <div
        v-if="invites.state === 'ready'"
        ref="inviteList"
        class="relative min-w-0 overflow-x-auto"
      >
        <table class="w-full min-w-[480px] border-collapse text-left">
          <caption class="sr-only">
            Pending invite links
          </caption>
          <thead>
            <tr class="border-b border-line">
              <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Role</th>
              <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Created by</th>
              <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Created</th>
              <th scope="col" class="h-8 pr-3 text-caption font-normal text-ink3">Expires</th>
              <th scope="col" class="h-8 text-caption font-normal text-ink3">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="invite in invites.data"
              :key="invite.id"
              class="border-b border-line"
              data-invite-row
              :data-invite-id="invite.id"
            >
              <th scope="row" class="h-[38px] pr-3 font-normal">
                {{ ROLE_LABELS[invite.workspaceRole] }}
              </th>
              <td class="h-[38px] pr-3"><ActorChip :actor="creatorOf(invite)" /></td>
              <td class="h-[38px] pr-3 text-secondary text-ink2">
                {{ shortDate(invite.createdAt) }}
              </td>
              <td class="h-[38px] pr-3 text-secondary text-ink2">
                {{ shortDate(invite.expiresAt) }}
              </td>
              <td class="h-[38px] text-right">
                <BaseButton
                  v-if="canRevokeInvite(viewer, invite.workspaceRole)"
                  size="sm"
                  danger
                  data-revoke
                  @click="revoke(invite)"
                  >Revoke<span class="sr-only">
                    the {{ ROLE_LABELS[invite.workspaceRole].toLowerCase() }} invite from
                    {{ shortDate(invite.createdAt) }}</span
                  ></BaseButton
                >
                <span v-else class="text-secondary text-ink3">Only owners revoke</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </SettingsSection>
  </SettingsLayout>

  <InviteDialog
    v-model:open="inviteOpen"
    :roles="roles"
    :create="model.createInvite"
    :origin="origin"
  />

  <ConfirmDialog
    v-model:open="removeOpen"
    :title="removeIsSelf ? 'Leave this workspace?' : `Remove ${removing?.name ?? ''}?`"
    :message="removeMessage"
    :confirm-label="removeIsSelf ? 'Leave workspace' : 'Remove from workspace'"
    :busy="removeBusy"
    :error="removeError"
    @confirm="confirmRemove"
  />

  <ConfirmDialog
    v-model:open="selfChangeOpen"
    :title="`Change your role to ${selfChange ? ROLE_LABELS[selfChange] : ''}?`"
    message="You may lose the right to change roles. Only another owner or admin could change yours back."
    :confirm-label="`Change my role`"
    @confirm="confirmSelfChange"
    @update:open="onSelfChangeOpen"
  />
</template>
