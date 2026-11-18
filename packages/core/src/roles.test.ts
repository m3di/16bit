import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  agentHubRoleSchema,
  can,
  effectiveHubRole,
  HUB_ROLES,
  hubRoleSchema,
  type Action,
  type ActionScopes,
  type Decision,
  type HubRole,
  type Subject,
  type WorkspaceRole,
} from './index.ts'

// Each table below mirrors a table or footnote in docs/ROLES.md, cell for cell.

const user = (workspaceRole: WorkspaceRole, id = `u-${workspaceRole}`): Subject => ({
  id,
  kind: 'user',
  workspaceRole,
})
const agent: Subject = { id: 'agent-1', kind: 'agent', workspaceRole: 'member' }
const other = (workspaceRole: WorkspaceRole) => user(workspaceRole, `other-${workspaceRole}`)

const check = <A extends Action>(actor: Subject, action: A, scope?: ActionScopes[A]): Decision =>
  (can as (a: Subject, x: Action, s?: unknown) => Decision)(actor, action, scope)

const Y: Decision = 'allow'
const F: Decision = 'forbidden'
const N: Decision = 'not_found'

describe('workspace actions (ROLES.md "Workspace actions")', () => {
  const actors = [
    user('owner'),
    user('admin'),
    user('member'),
    user('viewer'),
    user('finance'),
    agent,
  ]

  type Row = [string, (a: Subject) => Decision, Decision[]]
  // Columns: owner, admin, member, viewer, finance, agent key.
  const rows: Row[] = [
    [
      'see the workspace and its member list',
      (a) => check(a, 'workspace.read'),
      [Y, Y, Y, Y, Y, F],
    ],
    ['see the names of every hub', (a) => check(a, 'hub.listAll'), [Y, Y, F, F, F, F]],
    [
      'see a hub without a grant',
      (a) => check(a, 'hub.see', { hubGrant: null }),
      [Y, Y, N, N, N, N],
    ],
    [
      'see hubs they hold a grant on',
      (a) => check(a, 'hub.see', { hubGrant: 'viewer' }),
      [Y, Y, Y, Y, Y, Y],
    ],
    ['invite members', (a) => check(a, 'member.invite', { role: 'member' }), [Y, Y, F, F, F, F]],
    [
      'change a member role',
      (a) =>
        check(a, 'member.changeRole', { target: other('member'), role: 'viewer', ownerCount: 1 }),
      [Y, Y, F, F, F, F],
    ],
    ['create a hub', (a) => check(a, 'hub.create'), [Y, Y, F, F, F, F]],
    [
      'grant access on a hub they hold no grant on',
      (a) => check(a, 'grant.set', { hubGrant: null, target: other('member'), role: 'editor' }),
      [Y, Y, N, N, N, N],
    ],
    [
      'grant access on a hub they hold a non-admin grant on',
      (a) => check(a, 'grant.set', { hubGrant: 'editor', target: other('member'), role: 'editor' }),
      [Y, Y, F, F, F, F],
    ],
    [
      'revoke access on a hub they hold no grant on',
      (a) => check(a, 'grant.revoke', { hubGrant: null, target: other('member') }),
      [Y, Y, N, N, N, N],
    ],
    [
      'create agent keys on a hub they hold a grant on',
      (a) => check(a, 'key.create', { hubGrant: 'editor', role: 'editor' }),
      [Y, Y, F, F, F, F],
    ],
    [
      'create agent keys on a hub they hold no grant on (²)',
      (a) => check(a, 'key.create', { hubGrant: null, role: 'editor' }),
      [F, F, N, N, N, N],
    ],
    [
      'list agent keys on a hub they hold a grant on',
      (a) => check(a, 'key.list', { hubGrant: 'viewer' }),
      [Y, Y, F, F, F, F],
    ],
    [
      'list agent keys on a hub they hold no grant on',
      (a) => check(a, 'key.list', { hubGrant: null }),
      [F, F, N, N, N, N],
    ],
    [
      'revoke any agent key, without a grant',
      (a) => check(a, 'key.revoke', { hubGrant: null }),
      [Y, Y, N, N, N, N],
    ],
    [
      'revoke an agent key with a non-admin grant',
      (a) => check(a, 'key.revoke', { hubGrant: 'editor' }),
      [Y, Y, F, F, F, F],
    ],
    ['billing', (a) => check(a, 'billing.manage'), [Y, F, F, F, Y, F]],
    [
      'delete an empty hub they hold no grant on (D52)',
      (a) => check(a, 'hub.delete', { hubGrant: null, ownerHoldsGrant: false }),
      [F, F, N, N, N, N],
    ],
    [
      'delete an empty hub they hold a grant on (D52)',
      (a) => check(a, 'hub.delete', { hubGrant: 'viewer', ownerHoldsGrant: false }),
      [Y, Y, F, F, F, F],
    ],
    [
      'delete an empty hub an owner holds a grant on (¹)',
      (a) => check(a, 'hub.delete', { hubGrant: 'hub_admin', ownerHoldsGrant: true }),
      [Y, F, F, F, F, F],
    ],
    [
      'list who holds a grant on a hub they hold no grant on',
      (a) => check(a, 'grant.list', { hubGrant: null }),
      [Y, Y, N, N, N, N],
    ],
    [
      'list who holds a grant on a hub they hold a non-admin grant on',
      (a) => check(a, 'grant.list', { hubGrant: 'editor' }),
      [Y, Y, F, F, F, F],
    ],
    [
      'remove a member',
      (a) => check(a, 'member.remove', { target: other('member'), ownerCount: 1 }),
      [Y, Y, F, F, F, F],
    ],
    ['rename the workspace', (a) => check(a, 'workspace.rename'), [Y, F, F, F, F, F]],
    ['delete the workspace', (a) => check(a, 'workspace.delete'), [Y, F, F, F, F, F]],
  ]

  for (const [name, run, expected] of rows) {
    it(name, () => {
      expect(actors.map((a) => run(a))).toEqual(expected)
    })
  }

  it('an agent with an owner workspace role still gets no workspace actions (D47)', () => {
    const odd: Subject = { ...agent, workspaceRole: 'owner' }
    for (const action of [
      'workspace.read',
      'workspace.rename',
      'hub.create',
      'hub.listAll',
      'billing.manage',
    ] as const) {
      expect(check(odd, action), action).toBe(F)
    }
    expect(check(odd, 'member.invite', { role: 'member' })).toBe(F)
    expect(check(odd, 'hub.see', { hubGrant: null })).toBe(N)
    expect(check(odd, 'key.revoke', { hubGrant: 'editor' })).toBe(F)
  })
})

describe('effective hub role (ROLES.md "Two layers")', () => {
  // Rows: workspace role. Columns: granted hub_admin, editor, commenter, viewer.
  const table: [WorkspaceRole, (HubRole | null)[]][] = [
    ['owner', ['hub_admin', 'editor', 'commenter', 'viewer']],
    ['admin', ['hub_admin', 'editor', 'commenter', 'viewer']],
    ['member', ['hub_admin', 'editor', 'commenter', 'viewer']],
    ['viewer', ['viewer', 'viewer', 'viewer', 'viewer']],
    ['finance', ['viewer', 'viewer', 'viewer', 'viewer']],
  ]
  for (const [role, expected] of table) {
    it(`${role} acts as`, () => {
      expect(HUB_ROLES.map((g) => effectiveHubRole(user(role), g))).toEqual(expected)
    })
  }

  it('agents act as their grant, never above editor', () => {
    expect(HUB_ROLES.map((g) => effectiveHubRole(agent, g))).toEqual([
      'editor',
      'editor',
      'commenter',
      'viewer',
    ])
  })

  it('no grant means no hub role, for every workspace role', () => {
    for (const r of ['owner', 'admin', 'member', 'viewer', 'finance'] as const) {
      expect(effectiveHubRole(user(r), null)).toBeNull()
    }
    expect(effectiveHubRole(agent, null)).toBeNull()
  })
})

describe('hub actions (ROLES.md "Hub actions")', () => {
  // The actor is a workspace member, so the effective hub role is the grant.
  const actor = user('member')
  type Row = [string, (g: HubRole) => Decision, Decision[]]
  // Columns: hub admin, editor, commenter, viewer.
  const rows: Row[] = [
    [
      'describe the hub, read and query items',
      (g) => check(actor, 'hub.read', { hubGrant: g }),
      [Y, Y, Y, Y],
    ],
    [
      'create, edit and delete items',
      (g) => check(actor, 'item.write', { hubGrant: g }),
      [Y, Y, F, F],
    ],
    ['comment', (g) => check(actor, 'comment.create', { hubGrant: g }), [Y, Y, Y, F]],
    ['rename the hub', (g) => check(actor, 'hub.rename', { hubGrant: g }), [Y, F, F, F]],
    [
      'manage folders and attributes',
      (g) => check(actor, 'hub.manageSchema', { hubGrant: g }),
      [Y, F, F, F],
    ],
    [
      'grant access on this hub',
      (g) => check(actor, 'grant.set', { hubGrant: g, target: other('member'), role: 'viewer' }),
      [Y, F, F, F],
    ],
    [
      'revoke access on this hub',
      (g) => check(actor, 'grant.revoke', { hubGrant: g, target: other('member') }),
      [Y, F, F, F],
    ],
    [
      'create agent keys for this hub',
      (g) => check(actor, 'key.create', { hubGrant: g, role: 'viewer' }),
      [Y, F, F, F],
    ],
    [
      'list who holds a grant on this hub',
      (g) => check(actor, 'grant.list', { hubGrant: g }),
      [Y, F, F, F],
    ],
    [
      'list agent keys for this hub',
      (g) => check(actor, 'key.list', { hubGrant: g }),
      [Y, F, F, F],
    ],
    [
      'revoke agent keys for this hub',
      (g) => check(actor, 'key.revoke', { hubGrant: g }),
      [Y, F, F, F],
    ],
  ]

  for (const [name, run, expected] of rows) {
    it(name, () => {
      expect(HUB_ROLES.map((g) => run(g))).toEqual(expected)
    })
  }

  it('viewer and finance with a hub admin grant act as viewer', () => {
    for (const r of ['viewer', 'finance'] as const) {
      const a = user(r)
      expect(check(a, 'hub.read', { hubGrant: 'hub_admin' })).toBe(Y)
      expect(check(a, 'item.write', { hubGrant: 'hub_admin' })).toBe(F)
      expect(check(a, 'comment.create', { hubGrant: 'hub_admin' })).toBe(F)
      expect(check(a, 'hub.manageSchema', { hubGrant: 'hub_admin' })).toBe(F)
      expect(
        check(a, 'grant.set', { hubGrant: 'hub_admin', target: other('member'), role: 'viewer' }),
      ).toBe(F)
      expect(check(a, 'key.create', { hubGrant: 'hub_admin', role: 'viewer' })).toBe(F)
    }
  })

  it('owners and admins act by their grant inside a hub', () => {
    for (const r of ['owner', 'admin'] as const) {
      expect(check(user(r), 'item.write', { hubGrant: 'viewer' })).toBe(F)
      expect(check(user(r), 'hub.rename', { hubGrant: 'editor' })).toBe(F)
      expect(check(user(r), 'hub.manageSchema', { hubGrant: 'hub_admin' })).toBe(Y)
    }
  })
})

describe('hidden resources are not found, not forbidden (D27, D45)', () => {
  const inside = [
    'hub.read',
    'item.write',
    'comment.create',
    'hub.manageSchema',
    'relation.target',
  ] as const
  const everyone = [
    user('owner'),
    user('admin'),
    user('member'),
    user('viewer'),
    user('finance'),
    agent,
  ]

  for (const action of inside) {
    it(`${action} without a grant is not found for every principal, owners included`, () => {
      expect(everyone.map((a) => check(a, action, { hubGrant: null }))).toEqual(
        everyone.map(() => N),
      )
    })
  }

  it('hub-level actions on a hub the principal cannot see are not found', () => {
    for (const a of [user('member'), user('viewer'), user('finance'), agent]) {
      expect(check(a, 'hub.rename', { hubGrant: null })).toBe(N)
      expect(check(a, 'hub.delete', { hubGrant: null, ownerHoldsGrant: false })).toBe(N)
      expect(check(a, 'grant.list', { hubGrant: null })).toBe(N)
      expect(check(a, 'key.revoke', { hubGrant: null })).toBe(N)
    }
  })

  it('an owner or admin can see a hub without a grant but not rename it', () => {
    expect(check(user('owner'), 'hub.rename', { hubGrant: null })).toBe(F)
    expect(check(user('admin'), 'hub.rename', { hubGrant: null })).toBe(F)
  })
})

describe('footnote ¹: admins and owners', () => {
  const cases: [string, Subject, Action, unknown, Decision][] = [
    ['admin invites an owner', user('admin'), 'member.invite', { role: 'owner' }, F],
    ['admin invites an admin', user('admin'), 'member.invite', { role: 'admin' }, Y],
    ['owner invites an owner', user('owner'), 'member.invite', { role: 'owner' }, Y],
    [
      'admin promotes a member to owner',
      user('admin'),
      'member.changeRole',
      { target: other('member'), role: 'owner', ownerCount: 1 },
      F,
    ],
    [
      'admin demotes an owner',
      user('admin'),
      'member.changeRole',
      { target: other('owner'), role: 'member', ownerCount: 3 },
      F,
    ],
    [
      'admin demotes another admin',
      user('admin'),
      'member.changeRole',
      { target: other('admin'), role: 'member', ownerCount: 1 },
      Y,
    ],
    [
      'admin removes an owner',
      user('admin'),
      'member.remove',
      { target: other('owner'), ownerCount: 3 },
      F,
    ],
    [
      'admin removes an admin',
      user('admin'),
      'member.remove',
      { target: other('admin'), ownerCount: 1 },
      Y,
    ],
    [
      'owner promotes a member to owner',
      user('owner'),
      'member.changeRole',
      { target: other('member'), role: 'owner', ownerCount: 1 },
      Y,
    ],
    [
      'owner demotes another owner when two remain',
      user('owner'),
      'member.changeRole',
      { target: other('owner'), role: 'admin', ownerCount: 2 },
      Y,
    ],
    [
      'owner removes another owner when two remain',
      user('owner'),
      'member.remove',
      { target: other('owner'), ownerCount: 2 },
      Y,
    ],
    [
      'the last owner demotes themselves',
      user('owner'),
      'member.changeRole',
      { target: user('owner'), role: 'admin', ownerCount: 1 },
      F,
    ],
    [
      'the last owner removes themselves',
      user('owner'),
      'member.remove',
      { target: user('owner'), ownerCount: 1 },
      F,
    ],
    [
      'an owner keeps the owner role (no-op) as the last owner',
      user('owner'),
      'member.changeRole',
      { target: user('owner'), role: 'owner', ownerCount: 1 },
      Y,
    ],
    [
      'owner changes an agent principal role',
      user('owner'),
      'member.changeRole',
      { target: agent, role: 'admin', ownerCount: 1 },
      F,
    ],
    [
      'owner removes an agent principal as a member',
      user('owner'),
      'member.remove',
      { target: agent, ownerCount: 1 },
      F,
    ],
  ]
  for (const [name, actor, action, scope, expected] of cases) {
    it(name, () => {
      expect(check(actor, action, scope as never)).toBe(expected)
    })
  }
})

describe('footnote ³: hub admins granting', () => {
  const hubAdmin = user('member', 'hub-admin')
  const g = (target: Subject, role: HubRole = 'editor') => ({
    hubGrant: 'hub_admin' as const,
    target,
    role,
  })
  const cases: [string, Action, unknown, Decision][] = [
    ['grants hub admin to a member', 'grant.set', g(other('member'), 'hub_admin'), Y],
    ['grants viewer to a finance user', 'grant.set', g(other('finance'), 'viewer'), Y],
    ['changes their own grant', 'grant.set', g(hubAdmin, 'editor'), F],
    ['revokes their own grant', 'grant.revoke', { hubGrant: 'hub_admin', target: hubAdmin }, F],
    ['changes an owner grant', 'grant.set', g(other('owner')), F],
    ['changes an admin grant', 'grant.set', g(other('admin')), F],
    [
      'revokes an owner grant',
      'grant.revoke',
      { hubGrant: 'hub_admin', target: other('owner') },
      F,
    ],
    [
      'revokes an admin grant',
      'grant.revoke',
      { hubGrant: 'hub_admin', target: other('admin') },
      F,
    ],
    [
      'revokes a member grant',
      'grant.revoke',
      { hubGrant: 'hub_admin', target: other('member') },
      Y,
    ],
    ['grants to an agent principal', 'grant.set', g(agent, 'viewer'), F],
  ]
  for (const [name, action, scope, expected] of cases) {
    it(`hub admin ${name}`, () => {
      expect(check(hubAdmin, action, scope as never)).toBe(expected)
    })
  }

  it('owners and admins can grant themselves any hub role, without a grant (D45)', () => {
    for (const r of ['owner', 'admin'] as const) {
      const a = user(r)
      expect(check(a, 'grant.set', { hubGrant: null, target: a, role: 'hub_admin' })).toBe(Y)
      expect(check(a, 'grant.revoke', { hubGrant: 'viewer', target: a })).toBe(Y)
      expect(
        check(a, 'grant.set', { hubGrant: null, target: other('admin'), role: 'viewer' }),
      ).toBe(Y)
    }
  })
})

describe("footnote ¹: an admin cannot touch an owner's hub grant", () => {
  const admin = user('admin')
  const owner = user('owner')
  // Columns: the actor holds no grant, viewer, hub admin.
  const own = [null, 'viewer', 'hub_admin'] as const

  it('admin sets, changes or revokes an owner grant', () => {
    expect(
      own.map((g) =>
        can(admin, 'grant.set', { hubGrant: g, target: other('owner'), role: 'viewer' }),
      ),
    ).toEqual([F, F, F])
    expect(
      own.map((g) => can(admin, 'grant.revoke', { hubGrant: g, target: other('owner') })),
    ).toEqual([F, F, F])
  })

  it("owner sets or revokes another owner's grant", () => {
    expect(
      can(owner, 'grant.set', { hubGrant: null, target: other('owner'), role: 'editor' }),
    ).toBe(Y)
    expect(can(owner, 'grant.revoke', { hubGrant: null, target: other('owner') })).toBe(Y)
  })

  it("admin sets or revokes another admin's or a member's grant", () => {
    for (const target of [other('admin'), other('member')]) {
      expect(can(admin, 'grant.set', { hubGrant: null, target, role: 'hub_admin' })).toBe(Y)
      expect(can(admin, 'grant.revoke', { hubGrant: null, target })).toBe(Y)
    }
  })
})

describe('agent keys (ROLES.md "Agent keys", D28, D47)', () => {
  it('a key is never created with the hub admin role', () => {
    expect(check(user('owner'), 'key.create', { hubGrant: 'hub_admin', role: 'hub_admin' })).toBe(F)
    expect(check(user('member'), 'key.create', { hubGrant: 'hub_admin', role: 'hub_admin' })).toBe(
      F,
    )
    for (const role of ['editor', 'commenter', 'viewer'] as const) {
      expect(check(user('member'), 'key.create', { hubGrant: 'hub_admin', role })).toBe(Y)
    }
  })

  it("a key's role is capped at its creator's effective hub role", () => {
    // Rows: the creator's grant. Columns: key role editor, commenter, viewer.
    const roles = ['editor', 'commenter', 'viewer'] as const
    const table: [HubRole, Decision[]][] = [
      ['hub_admin', [Y, Y, Y]],
      ['editor', [Y, Y, Y]],
      ['commenter', [F, Y, Y]],
      ['viewer', [F, F, Y]],
    ]
    for (const r of ['owner', 'admin'] as const) {
      for (const [grant, expected] of table) {
        expect(
          roles.map((role) => can(user(r), 'key.create', { hubGrant: grant, role })),
          `${r} with ${grant}`,
        ).toEqual(expected)
      }
    }
    // A hub admin grant capped to viewer by the workspace role creates no keys at all.
    expect(can(user('viewer'), 'key.create', { hubGrant: 'hub_admin', role: 'viewer' })).toBe(F)
  })

  // Columns: agent granted editor, commenter, viewer.
  const grants = ['editor', 'commenter', 'viewer'] as const
  const rows: [string, (g: HubRole) => Decision, Decision[]][] = [
    ['read', (g) => check(agent, 'hub.read', { hubGrant: g }), [Y, Y, Y]],
    ['write items', (g) => check(agent, 'item.write', { hubGrant: g }), [Y, F, F]],
    ['comment', (g) => check(agent, 'comment.create', { hubGrant: g }), [Y, Y, F]],
    ['rename the hub', (g) => check(agent, 'hub.rename', { hubGrant: g }), [F, F, F]],
    [
      'manage folders and attributes',
      (g) => check(agent, 'hub.manageSchema', { hubGrant: g }),
      [F, F, F],
    ],
    [
      'grant',
      (g) => check(agent, 'grant.set', { hubGrant: g, target: other('member'), role: 'viewer' }),
      [F, F, F],
    ],
    ['create keys', (g) => check(agent, 'key.create', { hubGrant: g, role: 'viewer' }), [F, F, F]],
    ['list keys', (g) => check(agent, 'key.list', { hubGrant: g }), [F, F, F]],
    ['revoke keys', (g) => check(agent, 'key.revoke', { hubGrant: g }), [F, F, F]],
    [
      'delete the hub',
      (g) => check(agent, 'hub.delete', { hubGrant: g, ownerHoldsGrant: false }),
      [F, F, F],
    ],
    ['list grants', (g) => check(agent, 'grant.list', { hubGrant: g }), [F, F, F]],
  ]
  for (const [name, run, expected] of rows) {
    it(`an agent may ${name}`, () => {
      expect(grants.map((g) => run(g))).toEqual(expected)
    })
  }

  it('an agent holding a stray hub admin grant still cannot manage the hub', () => {
    expect(check(agent, 'item.write', { hubGrant: 'hub_admin' })).toBe(Y)
    expect(check(agent, 'hub.manageSchema', { hubGrant: 'hub_admin' })).toBe(F)
    expect(
      check(agent, 'grant.set', { hubGrant: 'hub_admin', target: other('member'), role: 'viewer' }),
    ).toBe(F)
    expect(check(agent, 'key.create', { hubGrant: 'hub_admin', role: 'viewer' })).toBe(F)
  })
})

describe('relations across hubs (ROLES.md "Relations across hubs")', () => {
  // The scope is the actor's grant on the target hub; the source hub is checked separately
  // with hub.manageSchema.
  it('needs at least viewer access on the target hub, for every workspace role', () => {
    for (const r of ['owner', 'admin', 'member', 'viewer', 'finance'] as const) {
      expect(
        HUB_ROLES.map((g) => check(user(r), 'relation.target', { hubGrant: g })),
        r,
      ).toEqual([Y, Y, Y, Y])
      expect(check(user(r), 'relation.target', { hubGrant: null }), r).toBe(N)
    }
  })
})

describe('typed calls', () => {
  it('each action takes exactly its own scope', () => {
    expect(can(user('owner'), 'workspace.read')).toBe(Y)
    expect(can(user('member'), 'hub.read', { hubGrant: 'viewer' })).toBe(Y)
    expect(can(user('owner'), 'key.create', { hubGrant: 'editor', role: 'editor' })).toBe(Y)
    expect(can(user('owner'), 'member.remove', { target: other('member'), ownerCount: 1 })).toBe(Y)

    // Type-level check only: never called.
    // @ts-expect-error: a hub action needs its scope.
    const missingScope = () => can(user('owner'), 'hub.read')
    expect(missingScope).toBeTypeOf('function')
    // @ts-expect-error: a workspace action takes no scope.
    can(user('owner'), 'workspace.read', { hubGrant: null })
    // @ts-expect-error: key.create needs the key's role.
    can(user('owner'), 'key.create', { hubGrant: 'editor' })
    // @ts-expect-error: hub.delete needs ownerHoldsGrant.
    can(user('owner'), 'hub.delete', { hubGrant: 'editor' })
    // @ts-expect-error: member.changeRole needs ownerCount.
    can(user('owner'), 'member.changeRole', { target: other('member'), role: 'viewer' })
  })
})

describe('schemas', () => {
  it('hub roles and agent hub roles', () => {
    expect(hubRoleSchema.options).toEqual(['hub_admin', 'editor', 'commenter', 'viewer'])
    expect(agentHubRoleSchema.safeParse('hub_admin').success).toBe(false)
    expect(agentHubRoleSchema.safeParse('editor').success).toBe(true)
  })

  it('every action is decided for every principal without throwing', () => {
    const scope = {
      hubGrant: 'editor',
      target: other('member'),
      role: 'viewer',
      ownerCount: 1,
      ownerHoldsGrant: false,
    }
    for (const a of [user('owner'), user('member'), agent]) {
      for (const action of ACTIONS) {
        expect([Y, F, N]).toContain(check(a, action, scope as never))
      }
    }
  })
})
