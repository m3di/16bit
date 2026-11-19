import { can, WORKSPACE_ROLES, type Principal, type Subject, type WorkspaceRole } from '@16bit/core'

// What the reader may do to each person on the members page. Every rule comes from `can()` in
// `@16bit/core` (docs/ROLES.md), so the page offers exactly what the API allows.

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
  finance: 'Finance',
}

export const subjectOf = (p: Pick<Principal, 'id' | 'kind' | 'workspaceRole'>): Subject => ({
  id: p.id,
  kind: p.kind,
  workspaceRole: p.workspaceRole,
})

export const ownerCount = (members: readonly Principal[]) =>
  members.filter((m) => m.workspaceRole === 'owner').length

/** Owners and admins manage members; everyone else sees the list read-only. */
export function canManage(viewer: Subject | null): boolean {
  if (!viewer) return false
  const anyMember: Subject = { id: '', kind: 'user', workspaceRole: 'member' }
  return can(viewer, 'member.remove', { target: anyMember, ownerCount: 2 }) === 'allow'
}

/**
 * The roles `viewer` may give `target`, in matrix order, the current one included. One entry
 * (only the current role) means the role is read-only for this reader.
 */
export function roleChoices(
  viewer: Subject | null,
  target: Principal,
  owners: number,
): WorkspaceRole[] {
  if (!viewer) return [target.workspaceRole]
  const t = subjectOf(target)
  return WORKSPACE_ROLES.filter(
    (role) =>
      role === target.workspaceRole ||
      can(viewer, 'member.changeRole', { target: t, role, ownerCount: owners }) === 'allow',
  )
}

/**
 * Why a manager cannot change this person's role, in words, or '' when they can or when the
 * reader manages nobody (the page says that once, not on every row).
 */
export function lockedReason(viewer: Subject | null, target: Principal, owners: number): string {
  if (!canManage(viewer) || !viewer) return ''
  if (roleChoices(viewer, target, owners).length > 1) return ''
  if (target.workspaceRole !== 'owner') return ''
  if (viewer.workspaceRole !== 'owner') return 'Only owners change owners'
  return owners <= 1 ? 'The only owner' : ''
  return ''
}

export type RemoveState = { kind: 'allowed' } | { kind: 'refused'; reason: string } | null

/**
 * Whether `viewer` may remove `target`. `refused` is shown as a disabled menu entry with its
 * reason (the last owner); `null` offers nothing, as for an admin looking at an owner.
 */
export function removeState(
  viewer: Subject | null,
  target: Principal,
  owners: number,
): RemoveState {
  if (!viewer || !canManage(viewer)) return null
  const decision = can(viewer, 'member.remove', { target: subjectOf(target), ownerCount: owners })
  if (decision === 'allow') return { kind: 'allowed' }
  if (viewer.workspaceRole === 'owner' && target.workspaceRole === 'owner' && owners <= 1) {
    return {
      kind: 'refused',
      reason: 'A workspace always has one owner. Make someone else owner first.',
    }
  }
  return null
}

/** The roles `viewer` may put on a new invite. Empty when they cannot invite at all. */
export function inviteRoles(viewer: Subject | null): WorkspaceRole[] {
  if (!viewer) return []
  return WORKSPACE_ROLES.filter((role) => can(viewer, 'member.invite', { role }) === 'allow')
}

export function canListInvites(viewer: Subject | null): boolean {
  return !!viewer && can(viewer, 'invite.list') === 'allow'
}

export function canRevokeInvite(viewer: Subject | null, role: WorkspaceRole): boolean {
  return !!viewer && can(viewer, 'invite.revoke', { role }) === 'allow'
}

/** The line under the page title: who the reader is here, and what that lets them do. */
export function viewerSummary(role: WorkspaceRole | null): string {
  const scope = 'A workspace role sets what someone can do; hub access sets where.'
  switch (role) {
    case 'owner':
      return `You own this workspace. ${scope}`
    case 'admin':
      return `You are an admin of this workspace. ${scope} Only owners change owners.`
    case null:
      return 'Only owners and admins change roles and invite people.'
    default:
      return `You are ${role === 'member' ? 'a member' : `in the ${ROLE_LABELS[role].toLowerCase()} role`} of this workspace. Only owners and admins change roles and invite people.`
  }
}

/** "Nov 14", with the year when it is not this year. */
export function shortDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const sameYear = date.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date)
}

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`

/** "7 people, 1 invite pending". Invites are left out when the reader cannot see them. */
export function peopleSummary(people: number, invites: number | null): string {
  const base = plural(people, 'person', 'people')
  return invites === null || invites === 0
    ? base
    : `${base}, ${plural(invites, 'invite', 'invites')} pending`
}
