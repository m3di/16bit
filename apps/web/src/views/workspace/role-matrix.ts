import {
  can,
  effectiveHubRole,
  HUB_ROLES,
  WORKSPACE_ROLES,
  type Decision,
  type HubRole,
  type Subject,
} from '@16bit/core'
import { HUB_ROLE_LABELS } from '../hub-settings/access.ts'
import { ROLE_LABELS } from './members.ts'

// "What each role can do" on Members and roles (issue 138). Only the wording is written here:
// every Yes, No and limit is a decision of `can()` from `@16bit/core`, asked with a
// representative principal and scope, so the table cannot drift from docs/ROLES.md. A limit
// shows only when `can()` refuses the case it describes.

/** `can()` itself, or a wrapper that records what it is asked (the coverage test). */
export type Ask = typeof can

/** One column: who acts, and the grant they hold on the hub a probe asks about. */
export interface MatrixColumn {
  key: string
  label: string
  actor: Subject
  /** The column's hub grant. Workspace columns hold none; probes pass their own. */
  grant: HubRole | null
}

/**
 * One question to `can()`. `limit` is shown when this case is refused while another case of
 * the same row is allowed, so it says what the column cannot do.
 */
interface Probe {
  limit: string
  decide: (ask: Ask, column: MatrixColumn) => Decision
}

interface RowSpec {
  key: string
  label: string
  probes: readonly Probe[]
}

export type MatrixCell =
  | { kind: 'yes' }
  | { kind: 'no' }
  /** Allowed with limits: the limits of the refused cases. */
  | { kind: 'limited'; limits: string[] }

export interface MatrixRow {
  key: string
  label: string
  cells: Record<string, MatrixCell>
}

export interface RoleMatrix {
  key: 'workspace' | 'hub'
  columns: MatrixColumn[]
  rows: MatrixRow[]
}

const READER = 'reader'
const user = (workspaceRole: Subject['workspaceRole'], id = READER): Subject => ({
  id,
  kind: 'user',
  workspaceRole,
})
/** Someone else in the workspace, whose membership or grant is acted on. */
const other = (workspaceRole: Subject['workspaceRole']) => user(workspaceRole, 'other')

export const WORKSPACE_COLUMNS: MatrixColumn[] = [
  ...WORKSPACE_ROLES.map((role) => ({
    key: role,
    label: ROLE_LABELS[role],
    actor: user(role),
    grant: null,
  })),
  // Every agent key is its own principal with workspace role member (D47).
  {
    key: 'agent',
    label: 'Agent key',
    actor: { id: READER, kind: 'agent', workspaceRole: 'member' },
    grant: null,
  },
]

/** Hub roles act as a member holding that grant, so no workspace cap applies. */
export const HUB_COLUMNS: MatrixColumn[] = HUB_ROLES.map((role) => ({
  key: role,
  label: HUB_ROLE_LABELS[role],
  actor: user('member'),
  grant: role,
}))

const MANY_OWNERS = 2

const WORKSPACE_ROWS: RowSpec[] = [
  {
    key: 'workspace.read',
    label: 'See the workspace and its member list',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'workspace.read') }],
  },
  {
    key: 'hub.listAll',
    label: 'See the names of every hub',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'hub.listAll') }],
  },
  {
    key: 'hub.see',
    label: 'See hubs they hold a grant on',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'hub.see', { hubGrant: 'viewer' }) }],
  },
  {
    key: 'invite',
    label: 'Invite members, see and end pending invites',
    probes: [
      { limit: '', decide: (ask, c) => ask(c.actor, 'member.invite', { role: 'member' }) },
      { limit: '', decide: (ask, c) => ask(c.actor, 'invite.list') },
      { limit: '', decide: (ask, c) => ask(c.actor, 'invite.revoke', { role: 'member' }) },
      {
        limit: 'Not owner invites',
        decide: (ask, c) =>
          worst(
            ask(c.actor, 'member.invite', { role: 'owner' }),
            ask(c.actor, 'invite.revoke', { role: 'owner' }),
          ),
      },
    ],
  },
  {
    key: 'member.changeRole',
    label: 'Change members’ roles',
    probes: [
      {
        limit: '',
        decide: (ask, c) =>
          ask(c.actor, 'member.changeRole', {
            target: other('member'),
            role: 'viewer',
            ownerCount: MANY_OWNERS,
          }),
      },
      {
        limit: 'Not to or from owner',
        decide: (ask, c) =>
          worst(
            ask(c.actor, 'member.changeRole', {
              target: other('owner'),
              role: 'admin',
              ownerCount: MANY_OWNERS,
            }),
            ask(c.actor, 'member.changeRole', {
              target: other('member'),
              role: 'owner',
              ownerCount: MANY_OWNERS,
            }),
          ),
      },
      {
        limit: 'Not the last owner',
        decide: (ask, c) =>
          ask(c.actor, 'member.changeRole', {
            target: other('owner'),
            role: 'admin',
            ownerCount: 1,
          }),
      },
    ],
  },
  {
    key: 'member.remove',
    label: 'Remove a member',
    probes: [
      {
        limit: '',
        decide: (ask, c) =>
          ask(c.actor, 'member.remove', { target: other('member'), ownerCount: MANY_OWNERS }),
      },
      {
        limit: 'Not owners',
        decide: (ask, c) =>
          ask(c.actor, 'member.remove', { target: other('owner'), ownerCount: MANY_OWNERS }),
      },
      {
        limit: 'Not the last owner',
        decide: (ask, c) =>
          ask(c.actor, 'member.remove', { target: other('owner'), ownerCount: 1 }),
      },
    ],
  },
  {
    key: 'hub.create',
    label: 'Create a hub (the creator becomes its hub admin)',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'hub.create') }],
  },
  {
    key: 'hub.delete',
    label: 'Delete an empty hub they hold a grant on',
    probes: [
      {
        limit: '',
        decide: (ask, c) =>
          ask(c.actor, 'hub.delete', { hubGrant: 'editor', ownerHoldsGrant: false }),
      },
      {
        limit: 'Not one an owner holds a grant on',
        decide: (ask, c) =>
          ask(c.actor, 'hub.delete', { hubGrant: 'editor', ownerHoldsGrant: true }),
      },
    ],
  },
  {
    key: 'grant.any',
    label: 'Grant or revoke access on any hub',
    probes: [
      {
        limit: '',
        decide: (ask, c) =>
          ask(c.actor, 'grant.set', { hubGrant: null, target: other('member'), role: 'editor' }),
      },
      {
        limit: '',
        decide: (ask, c) =>
          ask(c.actor, 'grant.revoke', { hubGrant: null, target: other('member') }),
      },
      {
        limit: 'Not an owner’s grant',
        decide: (ask, c) =>
          worst(
            ask(c.actor, 'grant.set', { hubGrant: null, target: other('owner'), role: 'editor' }),
            ask(c.actor, 'grant.revoke', { hubGrant: null, target: other('owner') }),
          ),
      },
    ],
  },
  {
    key: 'grant.listAny',
    label: 'List who holds a grant on any hub',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'grant.list', { hubGrant: null }) }],
  },
  {
    key: 'key.create',
    label: 'Create agent keys on a hub they hold a grant on',
    probes: [
      {
        limit: '',
        decide: (ask, c) => ask(c.actor, 'key.create', { hubGrant: 'editor', role: 'editor' }),
      },
      {
        limit: 'Up to their own hub role',
        decide: (ask, c) => ask(c.actor, 'key.create', { hubGrant: 'viewer', role: 'editor' }),
      },
      {
        limit: 'Never a hub admin key',
        decide: (ask, c) =>
          ask(c.actor, 'key.create', { hubGrant: 'hub_admin', role: 'hub_admin' }),
      },
    ],
  },
  {
    key: 'key.list',
    label: 'List the agent keys of a hub they hold a grant on',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'key.list', { hubGrant: 'editor' }) }],
  },
  {
    key: 'key.revoke',
    label: 'Revoke any agent key in the workspace',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'key.revoke', { hubGrant: null }) }],
  },
  {
    key: 'billing.manage',
    label: 'Billing (no billing exists yet)',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'billing.manage') }],
  },
  {
    key: 'workspace.manage',
    label: 'Rename or delete the workspace',
    probes: [
      { limit: '', decide: (ask, c) => ask(c.actor, 'workspace.rename') },
      { limit: '', decide: (ask, c) => ask(c.actor, 'workspace.delete') },
    ],
  },
]

const onHub = (c: MatrixColumn) => ({ hubGrant: c.grant })

const HUB_ROWS: RowSpec[] = [
  {
    key: 'hub.read',
    label: 'Describe the hub, read and query items',
    probes: [
      { limit: '', decide: (ask, c) => ask(c.actor, 'hub.see', onHub(c)) },
      { limit: '', decide: (ask, c) => ask(c.actor, 'hub.read', onHub(c)) },
    ],
  },
  {
    key: 'item.write',
    label: 'Create, edit and delete items',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'item.write', onHub(c)) }],
  },
  {
    key: 'comment.create',
    label: 'Comment (when comments exist)',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'comment.create', onHub(c)) }],
  },
  {
    key: 'relation.target',
    label: 'Link to this hub from a relation in another hub',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'relation.target', onHub(c)) }],
  },
  {
    key: 'hub.manage',
    label: 'Rename the hub, manage folders and attributes',
    probes: [
      { limit: '', decide: (ask, c) => ask(c.actor, 'hub.rename', onHub(c)) },
      { limit: '', decide: (ask, c) => ask(c.actor, 'hub.manageSchema', onHub(c)) },
    ],
  },
  {
    key: 'grant.list',
    label: 'List who holds a grant on this hub',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'grant.list', onHub(c)) }],
  },
  {
    key: 'grant.change',
    label: 'Grant or revoke access on this hub',
    probes: [
      {
        limit: '',
        decide: (ask, c) =>
          worst(
            ask(c.actor, 'grant.set', { ...onHub(c), target: other('member'), role: 'hub_admin' }),
            ask(c.actor, 'grant.revoke', { ...onHub(c), target: other('member') }),
          ),
      },
      {
        limit: 'Not their own grant',
        decide: (ask, c) =>
          ask(c.actor, 'grant.set', { ...onHub(c), target: c.actor, role: 'viewer' }),
      },
      {
        limit: 'Not a workspace owner’s or admin’s grant',
        decide: (ask, c) =>
          worst(
            ask(c.actor, 'grant.set', { ...onHub(c), target: other('owner'), role: 'viewer' }),
            ask(c.actor, 'grant.revoke', { ...onHub(c), target: other('admin') }),
          ),
      },
    ],
  },
  {
    key: 'key.manage',
    label: 'Create and revoke agent keys for this hub',
    probes: [
      {
        limit: '',
        decide: (ask, c) => ask(c.actor, 'key.create', { ...onHub(c), role: 'editor' }),
      },
      { limit: '', decide: (ask, c) => ask(c.actor, 'key.revoke', onHub(c)) },
      {
        limit: 'Never a hub admin key',
        decide: (ask, c) => ask(c.actor, 'key.create', { ...onHub(c), role: 'hub_admin' }),
      },
    ],
  },
  {
    key: 'key.list',
    label: 'List the agent keys of this hub',
    probes: [{ limit: '', decide: (ask, c) => ask(c.actor, 'key.list', onHub(c)) }],
  },
]

/** Allowed only when both are: one case made of two questions. */
function worst(a: Decision, b: Decision): Decision {
  return a === 'allow' ? b : a
}

function cellOf(spec: RowSpec, column: MatrixColumn, ask: Ask): MatrixCell {
  const refused = spec.probes.filter((p) => p.decide(ask, column) !== 'allow')
  if (refused.length === 0) return { kind: 'yes' }
  if (refused.length === spec.probes.length) return { kind: 'no' }
  // A refused main case (no limit of its own) still counts as a limit worth saying.
  return { kind: 'limited', limits: refused.map((p) => p.limit || 'Only in part') }
}

function build(
  key: RoleMatrix['key'],
  columns: MatrixColumn[],
  specs: RowSpec[],
  ask: Ask,
): RoleMatrix {
  return {
    key,
    columns,
    rows: specs.map((spec) => ({
      key: spec.key,
      label: spec.label,
      cells: Object.fromEntries(columns.map((c) => [c.key, cellOf(spec, c, ask)])),
    })),
  }
}

/** Both tables, asked of `ask` (`can` unless a test records the questions). */
export function roleMatrices(ask: Ask = can): { workspace: RoleMatrix; hub: RoleMatrix } {
  return {
    workspace: build('workspace', WORKSPACE_COLUMNS, WORKSPACE_ROWS, ask),
    hub: build('hub', HUB_COLUMNS, HUB_ROWS, ask),
  }
}

/**
 * The highest hub role each workspace column acts with, grouped: "Owner, Admin, Member: hub
 * admin". From `effectiveHubRole`, the cap `can()` applies.
 */
export function hubRoleCaps(): { labels: string[]; highest: string }[] {
  const groups = new Map<HubRole, string[]>()
  for (const c of WORKSPACE_COLUMNS) {
    const highest = effectiveHubRole(c.actor, 'hub_admin')
    if (highest === null) continue
    groups.set(highest, [...(groups.get(highest) ?? []), c.label])
  }
  return [...groups].map(([role, labels]) => ({
    labels,
    highest: HUB_ROLE_LABELS[role].toLowerCase(),
  }))
}

/** "Owner, Admin and Member act as hub admin at most; …", for the note under the hub table. */
export function hubRoleCapText(): string {
  const parts = hubRoleCaps().map(({ labels, highest }) => {
    const who =
      labels.length > 1
        ? `${labels.slice(0, -1).join(', ')} and ${labels.slice(-1).join('')}`
        : labels.join('')
    return `${who} ${labels.length > 1 ? 'act' : 'acts'} as ${highest} at most`
  })
  return `A hub grant is capped by the workspace role: ${parts.join('; ')}.`
}

export const CELL_TEXT: Record<MatrixCell['kind'], string> = {
  yes: 'Yes',
  no: 'No',
  limited: 'Yes, with limits',
}
