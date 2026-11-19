import { z } from 'zod'
import { PRINCIPAL_KINDS, WORKSPACE_ROLES } from './entities.ts'

// The role matrix in docs/ROLES.md (D25-D28, D45, D47) as one pure function. The API is
// meant to call `can` before every action, with row-level security enforcing the same
// rules underneath.
// A change here is a change to docs/ROLES.md and is gated.

export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES)
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>

export const principalKindSchema = z.enum(PRINCIPAL_KINDS)
export type PrincipalKind = z.infer<typeof principalKindSchema>

/** Highest first. */
export const HUB_ROLES = ['hub_admin', 'editor', 'commenter', 'viewer'] as const
export const hubRoleSchema = z.enum(HUB_ROLES)
export type HubRole = z.infer<typeof hubRoleSchema>

/** An agent key's one hub grant is never `hub_admin` (D28, D47). */
export const AGENT_HUB_ROLES = ['editor', 'commenter', 'viewer'] as const
export const agentHubRoleSchema = z.enum(AGENT_HUB_ROLES)
export type AgentHubRole = z.infer<typeof agentHubRoleSchema>

/** Who is acting, or whose grant or membership is being acted on. */
export interface Subject {
  id: string
  kind: PrincipalKind
  workspaceRole: WorkspaceRole
}

/** `hubGrant` is always the acting principal's own grant on the hub, or null. */
export interface HubScope {
  hubGrant: HubRole | null
}

export interface ActionScopes {
  // Workspace actions
  'workspace.read': undefined
  'workspace.rename': undefined
  'workspace.delete': undefined
  'billing.manage': undefined
  /** See the names of every hub, including ones the actor holds no grant on. */
  'hub.listAll': undefined
  'hub.create': undefined
  /** `role` is the workspace role the invite carries. */
  'member.invite': { role: WorkspaceRole }
  /**
   * List the workspace's pending invites, owner-role ones included. Part of "Invite members"
   * in docs/ROLES.md: whoever may invite sees what is pending.
   */
  'invite.list': undefined
  /** End a pending invite. `role` is the workspace role it carries: as `member.invite` (¹). */
  'invite.revoke': { role: WorkspaceRole }
  /** `ownerCount` is the number of owners in the workspace now. */
  'member.changeRole': { target: Subject; role: WorkspaceRole; ownerCount: number }
  'member.remove': { target: Subject; ownerCount: number }

  // Hub actions. Visibility of the hub itself.
  'hub.see': HubScope
  /**
   * Delete an empty hub (D52): owners and admins holding a grant on it. `ownerHoldsGrant`: a
   * workspace owner holds a grant on the hub, which refuses an admin (footnote ¹). That the hub
   * is empty and no other hub's relation targets it is checked by the server.
   */
  'hub.delete': HubScope & { ownerHoldsGrant: boolean }
  'hub.rename': HubScope
  /** Set or change `target`'s grant on this hub. */
  'grant.set': HubScope & { target: Subject; role: HubRole }
  'grant.revoke': HubScope & { target: Subject }
  /**
   * List who holds a grant on this hub, names and hub roles only: the hub's hub admins, and
   * owners and admins with or without a grant (they see every hub's name anyway).
   */
  'grant.list': HubScope
  /** `role` is the hub role the new key gets: at most the creator's effective hub role. */
  'key.create': HubScope & { role: HubRole }
  /** List the hub's agent keys: whoever may create keys on the hub. */
  'key.list': HubScope
  'key.revoke': HubScope

  // Actions inside a hub: 404 without a grant (D27, D45).
  'hub.read': HubScope
  'item.write': HubScope
  'comment.create': HubScope
  'hub.manageSchema': HubScope
  /**
   * Point a new relation attribute at this hub from another one (crossHub, D11). Needs at
   * least viewer access here; the source hub needs `hub.manageSchema` as well. Relations into
   * their own hub need no check. The target is fixed once created (D51).
   */
  'relation.target': HubScope
}

export type Action = keyof ActionScopes
export const ACTIONS = [
  'workspace.read',
  'workspace.rename',
  'workspace.delete',
  'billing.manage',
  'hub.listAll',
  'hub.create',
  'member.invite',
  'invite.list',
  'invite.revoke',
  'member.changeRole',
  'member.remove',
  'hub.see',
  'hub.delete',
  'hub.rename',
  'grant.set',
  'grant.revoke',
  'grant.list',
  'key.create',
  'key.list',
  'key.revoke',
  'hub.read',
  'item.write',
  'comment.create',
  'hub.manageSchema',
  'relation.target',
] as const satisfies readonly Action[]

/**
 * `forbidden` maps to 403, `not_found` to 404: hidden things are never confirmed to exist.
 * 401 (no session, bad key) is decided before `can` is called.
 */
export type Decision = 'allow' | 'forbidden' | 'not_found'

type ScopeArgs<A extends Action> = ActionScopes[A] extends undefined ? [] : [ActionScopes[A]]

const rank = (role: HubRole) => HUB_ROLES.length - HUB_ROLES.indexOf(role)
const atLeast = (role: HubRole | null, min: HubRole) => role !== null && rank(role) >= rank(min)
const lower = (a: HubRole, b: HubRole) => (rank(a) <= rank(b) ? a : b)

const isOwnerOrAdmin = (s: Subject) =>
  s.kind === 'user' && (s.workspaceRole === 'owner' || s.workspaceRole === 'admin')

/**
 * The hub role a principal acts with: their grant, capped by workspace role (viewer and
 * finance act as viewer at most). Agents never act as hub admin.
 */
export function effectiveHubRole(actor: Subject, grant: HubRole | null): HubRole | null {
  if (grant === null) return null
  if (actor.kind === 'agent') return lower(grant, 'editor')
  if (actor.workspaceRole === 'viewer' || actor.workspaceRole === 'finance') {
    return lower(grant, 'viewer')
  }
  return grant
}

const allowIf = (ok: boolean): Decision => (ok ? 'allow' : 'forbidden')

/** Owners and admins see every hub's name; everyone else only hubs they hold a grant on. */
const hubVisible = (actor: Subject, s: HubScope) => isOwnerOrAdmin(actor) || s.hubGrant !== null

/**
 * Footnote ¹: an admin cannot change, remove or create an owner, and the last owner
 * cannot stop being one.
 */
function changeMember(
  actor: Subject,
  target: Subject,
  newRole: WorkspaceRole | null,
  ownerCount: number,
): Decision {
  if (!isOwnerOrAdmin(actor)) return 'forbidden'
  // Agent principals are managed through their keys (D47).
  if (target.kind === 'agent') return 'forbidden'
  if (
    actor.workspaceRole === 'admin' &&
    (target.workspaceRole === 'owner' || newRole === 'owner')
  ) {
    return 'forbidden'
  }
  if (target.workspaceRole === 'owner' && newRole !== 'owner' && ownerCount <= 1) {
    return 'forbidden'
  }
  return 'allow'
}

/**
 * Owners and admins grant on any hub, themselves included, but an admin cannot touch an
 * owner's grant (¹). A hub admin grants any role, hub admin included, but not on their own
 * grant or a workspace owner's or admin's (³).
 */
function changeGrant(actor: Subject, s: HubScope & { target: Subject }): Decision {
  // An agent's one grant is created and removed with its key (D47).
  if (s.target.kind === 'agent') return 'forbidden'
  if (isOwnerOrAdmin(actor)) {
    return allowIf(!(actor.workspaceRole === 'admin' && s.target.workspaceRole === 'owner'))
  }
  if (effectiveHubRole(actor, s.hubGrant) !== 'hub_admin') return 'forbidden'
  if (s.target.id === actor.id || isOwnerOrAdmin(s.target)) return 'forbidden'
  return 'allow'
}

export function can<A extends Action>(actor: Subject, action: A, ...args: ScopeArgs<A>): Decision {
  const scope = args[0]
  return decide(actor, action, scope)
}

function decide(actor: Subject, action: Action, scope: ActionScopes[Action]): Decision {
  const role = actor.workspaceRole
  const isAgent = actor.kind === 'agent'

  switch (action) {
    case 'workspace.read':
      return allowIf(!isAgent)
    case 'workspace.rename':
    case 'workspace.delete':
      return allowIf(!isAgent && role === 'owner')
    case 'billing.manage':
      return allowIf(!isAgent && (role === 'owner' || role === 'finance'))
    case 'hub.listAll':
    case 'hub.create':
    case 'invite.list':
      return allowIf(isOwnerOrAdmin(actor))
    // Revoking follows creating: an admin can't end an owner-role invite either (¹).
    case 'member.invite':
    case 'invite.revoke': {
      const s = scope as ActionScopes['member.invite']
      if (!isOwnerOrAdmin(actor)) return 'forbidden'
      return allowIf(!(role === 'admin' && s.role === 'owner'))
    }
    case 'member.changeRole': {
      const s = scope as ActionScopes['member.changeRole']
      return changeMember(actor, s.target, s.role, s.ownerCount)
    }
    case 'member.remove': {
      const s = scope as ActionScopes['member.remove']
      return changeMember(actor, s.target, null, s.ownerCount)
    }
  }

  const s = scope as HubScope
  if (!hubVisible(actor, s)) return 'not_found'
  const hubRole = effectiveHubRole(actor, s.hubGrant)
  const hubAdmin = hubRole === 'hub_admin'

  switch (action) {
    case 'hub.see':
      return 'allow'
    case 'hub.delete': {
      const d = scope as ActionScopes['hub.delete']
      if (!isOwnerOrAdmin(actor) || hubRole === null) return 'forbidden'
      return allowIf(!(role === 'admin' && d.ownerHoldsGrant))
    }
    case 'hub.rename':
      return allowIf(hubAdmin)
    case 'grant.set':
    case 'grant.revoke':
      return changeGrant(actor, scope as ActionScopes['grant.set'])
    case 'grant.list':
      return allowIf(hubAdmin || isOwnerOrAdmin(actor))
    case 'key.create': {
      const k = scope as ActionScopes['key.create']
      if (k.role === 'hub_admin') return 'forbidden'
      // Footnote ²: owners and admins need a grant on the hub too, and no key gets more
      // than its creator's effective hub role (least privilege).
      if (!hubAdmin && !(isOwnerOrAdmin(actor) && hubRole !== null)) return 'forbidden'
      return allowIf(atLeast(hubRole, k.role))
    }
    case 'key.list':
      return allowIf(hubAdmin || (isOwnerOrAdmin(actor) && hubRole !== null))
    case 'key.revoke':
      return allowIf(hubAdmin || isOwnerOrAdmin(actor))
  }

  // Inside the hub: without a grant it does not exist, even for owners and admins (D45).
  if (hubRole === null) return 'not_found'
  switch (action) {
    case 'hub.read':
      return 'allow'
    case 'item.write':
      return allowIf(atLeast(hubRole, 'editor'))
    case 'comment.create':
      return allowIf(atLeast(hubRole, 'commenter'))
    case 'hub.manageSchema':
      return allowIf(hubAdmin)
    case 'relation.target':
      return 'allow'
  }
  // Adding an action without a rule fails to compile here instead of silently denying.
  const unhandled: never = action
  return unhandled
}
