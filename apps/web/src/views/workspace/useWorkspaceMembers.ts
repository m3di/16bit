import {
  changeMemberRoleSchema,
  createdInviteSchema,
  invitePageSchema,
  memberPageSchema,
  principalSchema,
  type CreatedInvite,
  type Invite,
  type Me,
  type Principal,
  type Subject,
  type WorkspaceRole,
} from '@16bit/core'
import { computed, ref } from 'vue'
import {
  asRequestError,
  getAllPages,
  noContent,
  sendJson,
  type ApiRequestError,
  type Fetch,
} from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'
import { canListInvites, ROLE_LABELS } from './members.ts'

/** The invite list, or `hidden` when the reader may not see it (members, viewers, finance). */
export type InvitesLoad = Load<Invite[]> | { state: 'hidden' }

/**
 * The members page's data: the workspace's people (`GET /members`), and for owners and admins
 * its pending invites (`GET /invites`). Role changes and invite revokes are optimistic and roll
 * back with a notice when the API refuses them. Removing a member is confirmed first, so it
 * waits for the answer inside its dialog instead.
 */
export function useWorkspaceMembers(
  workspaceId: string,
  me: () => Me | null,
  fetchFn: Fetch = (...args) => fetch(...args),
  /** Called after a change to the reader's own membership, so the session reads it again. */
  onSelfChange: () => Promise<void> | void = () => undefined,
) {
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId)}`
  const members = ref<Load<Principal[]>>({ state: 'loading' })
  const invites = ref<InvitesLoad>({ state: 'loading' })
  /** Why the last write was refused, shown above the table until dismissed or replaced. */
  const notice = ref<string | null>(null)

  const membership = computed(() => {
    const m = me()
    return m?.kind === 'person'
      ? (m.memberships.find((x) => x.workspace.id === workspaceId) ?? null)
      : null
  })

  /**
   * The reader as a subject, with the role from the member list once it has loaded (fresher
   * than the session's), else the session's. `null` for an agent or a non-member.
   */
  const viewer = computed((): Subject | null => {
    const own = membership.value
    if (!own) return null
    const row =
      members.value.state === 'ready'
        ? members.value.data.find((p) => p.id === own.principalId)
        : undefined
    return {
      id: own.principalId,
      kind: 'user',
      workspaceRole: row?.workspaceRole ?? own.workspaceRole,
    }
  })

  let generation = 0

  async function loadInvites(gen: number) {
    if (!canListInvites(viewer.value)) {
      invites.value = { state: 'hidden' }
      return
    }
    invites.value = { state: 'loading' }
    try {
      const list = await getAllPages(`${base}/invites`, invitePageSchema, fetchFn)
      if (gen === generation) invites.value = { state: 'ready', data: list }
    } catch (error) {
      if (gen === generation) invites.value = { state: 'error', error: asRequestError(error) }
    }
  }

  /**
   * Reads the lists. `keep` leaves the current rows on screen while they are read again, as
   * after a refused write; an error then keeps them too, since they were the best known.
   */
  async function load(options: { keep?: boolean } = {}) {
    const gen = ++generation
    const keep = options.keep === true && members.value.state === 'ready'
    if (!keep) members.value = { state: 'loading' }
    try {
      const list = await getAllPages(`${base}/members`, memberPageSchema, fetchFn)
      if (gen !== generation) return
      members.value = { state: 'ready', data: list }
    } catch (error) {
      if (gen === generation && !keep) {
        members.value = { state: 'error', error: asRequestError(error) }
        invites.value = { state: 'hidden' }
      }
      return
    }
    await loadInvites(gen)
  }

  function reloadInvites() {
    return loadInvites(generation)
  }

  const memberList = () => (members.value.state === 'ready' ? members.value.data : null)

  const fail = (what: string, error: ApiRequestError) =>
    `${what} ${error.isNoPermission ? 'Your role does not allow this.' : error.message}`

  // The last role each person is known to have on the server, and the latest request per
  // person, so an older answer arriving late never overwrites a newer choice.
  const confirmedRole = new Map<string, WorkspaceRole>()
  const latest = new Map<string, number>()
  let requestSeq = 0

  /** Sets the role at once, then asks the API. A refusal puts the last known role back. */
  async function changeRole(principalId: string, role: WorkspaceRole): Promise<void> {
    const list = memberList()
    const row = list?.find((p) => p.id === principalId)
    if (!list || !row || row.workspaceRole === role) return
    if (!confirmedRole.has(principalId)) confirmedRole.set(principalId, row.workspaceRole)
    const seq = ++requestSeq
    latest.set(principalId, seq)
    row.workspaceRole = role
    notice.value = null
    const isSelf = principalId === membership.value?.principalId
    try {
      const saved = await sendJson(
        'PATCH',
        `${base}/members/${encodeURIComponent(principalId)}`,
        changeMemberRoleSchema.parse({ workspaceRole: role }),
        principalSchema,
        fetchFn,
      )
      confirmedRole.set(principalId, saved.workspaceRole)
      if (latest.get(principalId) === seq) {
        row.workspaceRole = saved.workspaceRole
        confirmedRole.delete(principalId)
      }
      if (isSelf) {
        await onSelfChange()
        // The reader's own role changed what they may see: the invite list may now be hidden.
        await reloadInvites()
      }
    } catch (thrown) {
      const error = asRequestError(thrown)
      if (latest.get(principalId) !== seq) return
      const before = confirmedRole.get(principalId) ?? row.workspaceRole
      confirmedRole.delete(principalId)
      if (error.isNotFound) {
        // Removed by someone else meanwhile.
        dropMember(principalId)
        notice.value = `${row.name} is no longer a member of this workspace.`
        return
      }
      row.workspaceRole = before
      notice.value = fail(`${row.name}'s role was not changed to ${ROLE_LABELS[role]}.`, error)
      // A 403 means the roles here are not what the page thought: read them again.
      if (error.isNoPermission && !error.isUnauthorized) void load({ keep: true })
    }
  }

  function dropMember(principalId: string) {
    const list = memberList()
    if (!list) return
    const at = list.findIndex((p) => p.id === principalId)
    if (at !== -1) list.splice(at, 1)
  }

  /**
   * Removes a member after the reader confirmed it. Throws the request error so the dialog can
   * show it and stay open. Returns whether the reader removed themselves.
   */
  async function remove(principalId: string): Promise<{ self: boolean }> {
    notice.value = null
    const self = principalId === membership.value?.principalId
    try {
      await sendJson(
        'DELETE',
        `${base}/members/${encodeURIComponent(principalId)}`,
        undefined,
        noContent,
        fetchFn,
      )
    } catch (thrown) {
      const error = asRequestError(thrown)
      // Already gone: the goal is reached.
      if (!error.isNotFound) throw error
    }
    dropMember(principalId)
    if (self) await onSelfChange()
    return { self }
  }

  /** Removes the invite from the list at once; a refusal puts it back where it was. */
  async function revokeInvite(inviteId: string): Promise<void> {
    const state = invites.value
    if (state.state !== 'ready') return
    const at = state.data.findIndex((i) => i.id === inviteId)
    const invite = state.data[at]
    if (!invite) return
    state.data.splice(at, 1)
    notice.value = null
    try {
      await sendJson(
        'POST',
        `${base}/invites/${encodeURIComponent(inviteId)}/revoke`,
        {},
        noContent,
        fetchFn,
      )
    } catch (thrown) {
      const error = asRequestError(thrown)
      // An unknown invite has nothing left to revoke.
      if (error.isNotFound) return
      const now = invites.value
      if (now.state === 'ready' && !now.data.some((i) => i.id === inviteId)) {
        now.data.splice(Math.min(at, now.data.length), 0, invite)
      }
      notice.value = fail(
        `The ${ROLE_LABELS[invite.workspaceRole].toLowerCase()} invite was not revoked.`,
        error,
      )
    }
  }

  /** Creates an invite. Throws the request error for the dialog. The token is shown once. */
  async function createInvite(
    workspaceRole: WorkspaceRole,
    expiresInDays: number,
  ): Promise<CreatedInvite> {
    const created = await sendJson(
      'POST',
      `${base}/invites`,
      { workspaceRole, expiresInDays },
      createdInviteSchema,
      fetchFn,
    )
    const state = invites.value
    if (state.state === 'ready') state.data.unshift(created.invite)
    return created
  }

  function dismissNotice() {
    notice.value = null
  }

  return {
    members,
    invites,
    notice,
    viewer,
    membership,
    load,
    reloadInvites,
    changeRole,
    remove,
    revokeInvite,
    createInvite,
    dismissNotice,
  }
}

export type WorkspaceMembers = ReturnType<typeof useWorkspaceMembers>
