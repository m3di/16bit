import {
  AGENT_HUB_ROLES,
  can,
  effectiveHubRole,
  HUB_ROLES,
  type AgentHubRole,
  type AgentKeyState,
  type AgentKey,
  type Attribute,
  type HubDescription,
  type HubGrantEntry,
  type HubRole,
  type Me,
  type Subject,
} from '@16bit/core'
import { ROLE_LABELS } from '../workspace/members.ts'

// Who may do what in the general, access, agent key and danger sections of hub settings. Every
// rule comes from `can()` in `@16bit/core` (docs/ROLES.md), so the page offers exactly what the
// API allows. The hub role from the hub description stands in for the reader's own grant: it is
// already capped by workspace role, and a capped role never reaches `hub_admin`.

export const HUB_ROLE_LABELS: Record<HubRole, string> = {
  hub_admin: 'Hub admin',
  editor: 'Editor',
  commenter: 'Commenter',
  viewer: 'Viewer',
}

/** The reader as a `can()` subject in this workspace, or `null` for an agent or a non-member. */
export function viewerOf(me: Me | null, workspaceId: string): Subject | null {
  if (!me || me.kind !== 'person') return null
  const m = me.memberships.find((x) => x.workspace.id === workspaceId)
  return m ? { id: m.principalId, kind: 'user', workspaceRole: m.workspaceRole } : null
}

const allows = (decision: string) => decision === 'allow'

/** Rename, recolour and set the title attribute (`hub.rename`). */
export const canEditGeneral = (viewer: Subject | null, hubRole: HubRole) =>
  !!viewer && allows(can(viewer, 'hub.rename', { hubGrant: hubRole }))

export const GENERAL_READ_ONLY =
  'Only hub admins can rename this hub or change its colour and title.'

/** List who holds a grant (`grant.list`): the hub's hub admins, and owners and admins. */
export const canListGrants = (viewer: Subject | null, hubRole: HubRole) =>
  !!viewer && allows(can(viewer, 'grant.list', { hubGrant: hubRole }))

export const ACCESS_HIDDEN = 'Only hub admins and workspace owners and admins see who has access.'

const subjectOf = (g: Pick<HubGrantEntry, 'principalId' | 'kind' | 'workspaceRole'>): Subject => ({
  id: g.principalId,
  kind: g.kind,
  workspaceRole: g.workspaceRole,
})

/**
 * The hub roles the reader may give `target`, highest first, the current one included. One entry
 * means the role is read-only for this reader; `lockedGrantReason` says why.
 */
export function grantRoleChoices(
  viewer: Subject | null,
  hubRole: HubRole,
  target: HubGrantEntry,
): HubRole[] {
  if (!viewer) return [target.hubRole]
  const t = subjectOf(target)
  return HUB_ROLES.filter(
    (role) =>
      role === target.hubRole ||
      allows(can(viewer, 'grant.set', { hubGrant: hubRole, target: t, role })),
  )
}

export const canRevokeGrant = (viewer: Subject | null, hubRole: HubRole, target: HubGrantEntry) =>
  !!viewer && allows(can(viewer, 'grant.revoke', { hubGrant: hubRole, target: subjectOf(target) }))

/** Why the reader cannot change this grant, in words, or `''` when they can. */
export function lockedGrantReason(
  viewer: Subject | null,
  hubRole: HubRole,
  target: HubGrantEntry,
): string {
  if (!viewer || !canListGrants(viewer, hubRole)) return ''
  if (grantRoleChoices(viewer, hubRole, target).length > 1) return ''
  if (target.kind === 'agent') return 'Set by its key'
  if (target.principalId === viewer.id) return 'Your own access'
  if (target.workspaceRole === 'owner') return 'Only owners change owners'
  if (target.workspaceRole === 'admin') return 'Only owners and admins change admins'
  return ''
}

/**
 * The role someone acts with when it is lower than their grant (viewer and finance act as viewer
 * at most), as a note: "Acts as viewer". `''` otherwise.
 */
export function cappedNote(target: HubGrantEntry): string {
  const effective = effectiveHubRole(subjectOf(target), target.hubRole)
  return effective && effective !== target.hubRole
    ? `Acts as ${HUB_ROLE_LABELS[effective].toLowerCase()}`
    : ''
}

/**
 * "Owner", "Agent key": where someone's access comes from. An agent's grant stays when its key is
 * revoked or expires, and the grant list says so (`keyState`).
 */
export function sourceLabel(g: HubGrantEntry): string {
  if (g.kind !== 'agent') return ROLE_LABELS[g.workspaceRole]
  return g.keyState === 'active' ? 'Agent key' : `Agent key, ${g.keyState}`
}

/** The roles the reader may give someone who has no grant yet. */
export function newGrantRoles(
  viewer: Subject | null,
  hubRole: HubRole,
  target: Subject,
): HubRole[] {
  if (!viewer) return []
  return HUB_ROLES.filter((role) =>
    allows(can(viewer, 'grant.set', { hubGrant: hubRole, target, role })),
  )
}

/** List the hub's agent keys (`key.list`): hub admins, and owners and admins holding a grant. */
export const canListKeys = (viewer: Subject | null, hubRole: HubRole) =>
  !!viewer && allows(can(viewer, 'key.list', { hubGrant: hubRole }))

export const KEYS_HIDDEN =
  'Only hub admins, and workspace owners and admins with access to this hub, see its agent keys.'

/** The roles a new key may have: at most the reader's own effective hub role (least privilege). */
export function keyRoleChoices(viewer: Subject | null, hubRole: HubRole): AgentHubRole[] {
  if (!viewer) return []
  return AGENT_HUB_ROLES.filter((role) =>
    allows(can(viewer, 'key.create', { hubGrant: hubRole, role })),
  )
}

export const canRevokeKey = (viewer: Subject | null, hubRole: HubRole) =>
  !!viewer && allows(can(viewer, 'key.revoke', { hubGrant: hubRole }))

/** The same states the grant list reports for an agent (`keyState`). */
export type KeyStatus = AgentKeyState

export function keyStatus(key: AgentKey, now: Date = new Date()): KeyStatus {
  if (key.revokedAt) return 'revoked'
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now.getTime()) return 'expired'
  return 'active'
}

/** How long a new key lives. `null` days: it does not expire. */
export const KEY_LIFETIMES = [
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
  { value: '365', label: '1 year', days: 365 },
  { value: 'never', label: 'Never', days: null },
] as const

export function keyExpiry(value: string, now: Date = new Date()): string | null {
  const days = KEY_LIFETIMES.find((l) => l.value === value)?.days ?? null
  return days === null ? null : new Date(now.getTime() + days * 86_400_000).toISOString()
}

/** The hub's `text` attributes: the only ones that may title its items (D50). */
export const titleChoices = (description: HubDescription): Attribute[] =>
  description.attributes
    .filter((a) => a.type === 'text')
    .sort((a, b) => a.name.localeCompare(b.name))

const formatCount = (n: number) => new Intl.NumberFormat('en').format(n)

/**
 * The hub's item total. `itemCount` on the hub row is kept in every item write and counts every
 * item in the hub, those in folders included (docs/ARCHITECTURE.md).
 */
export const itemTotal = (n: number) =>
  `${n === 1 ? '1 item' : `${formatCount(n)} items`} in this hub, counting every folder.`

export type DeleteHubState =
  { kind: 'allowed' } | { kind: 'waiting' } | { kind: 'refused'; reason: string }

/**
 * Whether the reader may delete the hub (D52): owners and admins holding a grant, not an admin
 * while an owner holds one (footnote 1), and only once it holds no items and no folders. The
 * server checks all of it again, and also refuses a hub that another hub's relation targets.
 * `grants` is `null` while the grant list loads: an admin waits for it.
 */
export function deleteHubState(
  viewer: Subject | null,
  description: HubDescription,
  grants: readonly HubGrantEntry[] | null,
): DeleteHubState {
  const hubGrant = description.hubRole
  if (!viewer || (viewer.workspaceRole !== 'owner' && viewer.workspaceRole !== 'admin')) {
    return { kind: 'refused', reason: 'Only workspace owners and admins delete hubs.' }
  }
  if (viewer.workspaceRole === 'admin' && grants === null) return { kind: 'waiting' }
  const ownerHoldsGrant = (grants ?? []).some(
    (g) => g.kind === 'user' && g.workspaceRole === 'owner',
  )
  if (!allows(can(viewer, 'hub.delete', { hubGrant, ownerHoldsGrant }))) {
    return {
      kind: 'refused',
      reason: 'A workspace owner has access to this hub, so only an owner can delete it.',
    }
  }
  const items = description.hub.itemCount
  const folders = description.folders.length
  if (items > 0 || folders > 0) {
    const parts = [
      items > 0 ? (items === 1 ? '1 item' : `${formatCount(items)} items`) : '',
      folders > 0 ? (folders === 1 ? '1 folder' : `${formatCount(folders)} folders`) : '',
    ].filter(Boolean)
    return {
      kind: 'refused',
      reason: `It still holds ${parts.join(' and ')}. Delete or move them first.`,
    }
  }
  return { kind: 'allowed' }
}
