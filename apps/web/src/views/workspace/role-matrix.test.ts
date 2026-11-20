import { ACTIONS, can, type Action } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import {
  hubRoleCapText,
  roleMatrices,
  type Ask,
  type MatrixCell,
  type RoleMatrix,
} from './role-matrix.ts'

// The table is generated from `can()`; these tests keep it complete and spot-check it against
// docs/ROLES.md.

function recordingAsk(): { ask: Ask; asked: Set<Action> } {
  const asked = new Set<Action>()
  const ask = ((actor, action, ...args) => {
    asked.add(action)
    return can(actor, action, ...args)
  }) as Ask
  return { ask, asked }
}

const cell = (m: RoleMatrix, row: string, column: string): MatrixCell | undefined =>
  m.rows.find((r) => r.key === row)?.cells[column]

const yes = { kind: 'yes' }
const no = { kind: 'no' }
const limited = (...limits: string[]) => ({ kind: 'limited', limits })

describe('roleMatrices', () => {
  it('asks can() about every action it knows', () => {
    const { ask, asked } = recordingAsk()
    roleMatrices(ask)
    const missing = ACTIONS.filter((a) => !asked.has(a))
    expect(missing, `actions missing from the role table: ${missing.join(', ')}`).toEqual([])
  })

  it('only shows what can() decides: a different answer changes the table', () => {
    const allowAll = (() => 'allow') as Ask
    const { workspace, hub } = roleMatrices(allowAll)
    for (const m of [workspace, hub]) {
      for (const row of m.rows) {
        for (const c of m.columns) expect(row.cells[c.key]).toEqual(yes)
      }
    }
  })

  it('has a cell for every column of every row', () => {
    const { workspace, hub } = roleMatrices()
    for (const m of [workspace, hub]) {
      for (const row of m.rows) {
        expect(Object.keys(row.cells).sort()).toEqual(m.columns.map((c) => c.key).sort())
      }
    }
  })

  describe('workspace table (docs/ROLES.md, workspace actions)', () => {
    const { workspace: w } = roleMatrices()

    it('lists the workspace roles and an agent key', () => {
      expect(w.columns.map((c) => c.label)).toEqual([
        'Owner',
        'Admin',
        'Member',
        'Viewer',
        'Finance',
        'Agent key',
      ])
    })

    it('lets everyone but agents see the workspace', () => {
      expect(cell(w, 'workspace.read', 'finance')).toEqual(yes)
      expect(cell(w, 'workspace.read', 'agent')).toEqual(no)
    })

    it('limits admins per footnote ¹', () => {
      expect(cell(w, 'invite', 'owner')).toEqual(yes)
      expect(cell(w, 'invite', 'admin')).toEqual(limited('Not owner invites'))
      expect(cell(w, 'invite', 'member')).toEqual(no)
      expect(cell(w, 'member.changeRole', 'admin')).toEqual(
        limited('Not to or from owner', 'Not the last owner'),
      )
      expect(cell(w, 'member.changeRole', 'owner')).toEqual(limited('Not the last owner'))
      expect(cell(w, 'member.remove', 'admin')).toEqual(limited('Not owners', 'Not the last owner'))
      expect(cell(w, 'grant.any', 'admin')).toEqual(limited('Not an owner’s grant'))
      expect(cell(w, 'grant.any', 'owner')).toEqual(yes)
      expect(cell(w, 'hub.delete', 'admin')).toEqual(limited('Not one an owner holds a grant on'))
      expect(cell(w, 'hub.delete', 'owner')).toEqual(yes)
    })

    it('limits agent key creation per footnote ²', () => {
      expect(cell(w, 'key.create', 'owner')).toEqual(
        limited('Up to their own hub role', 'Never a hub admin key'),
      )
      expect(cell(w, 'key.create', 'member')).toEqual(no)
      expect(cell(w, 'key.create', 'agent')).toEqual(no)
    })

    it('gives billing to owners and finance only', () => {
      expect(
        w.columns.filter((c) => cell(w, 'billing.manage', c.key)?.kind === 'yes').map((c) => c.key),
      ).toEqual(['owner', 'finance'])
    })

    it('lets only owners rename or delete the workspace', () => {
      expect(
        w.columns
          .filter((c) => cell(w, 'workspace.manage', c.key)?.kind === 'yes')
          .map((c) => c.key),
      ).toEqual(['owner'])
    })
  })

  describe('hub table (docs/ROLES.md, hub actions)', () => {
    const { hub: h } = roleMatrices()
    const allowedFor = (row: string) =>
      h.columns.filter((c) => cell(h, row, c.key)?.kind !== 'no').map((c) => c.key)

    it('follows the hub roles', () => {
      expect(allowedFor('hub.read')).toEqual(['hub_admin', 'editor', 'commenter', 'viewer'])
      expect(allowedFor('item.write')).toEqual(['hub_admin', 'editor'])
      expect(allowedFor('comment.create')).toEqual(['hub_admin', 'editor', 'commenter'])
      expect(allowedFor('hub.manage')).toEqual(['hub_admin'])
      expect(allowedFor('grant.list')).toEqual(['hub_admin'])
      expect(allowedFor('key.manage')).toEqual(['hub_admin'])
      expect(allowedFor('key.list')).toEqual(['hub_admin'])
    })

    it('limits hub admins per footnote ³', () => {
      expect(cell(h, 'grant.change', 'hub_admin')).toEqual(
        limited('Not their own grant', 'Not a workspace owner’s or admin’s grant'),
      )
      expect(cell(h, 'key.manage', 'hub_admin')).toEqual(limited('Never a hub admin key'))
    })
  })

  it('states the hub role cap from effectiveHubRole', () => {
    expect(hubRoleCapText()).toBe(
      'A hub grant is capped by the workspace role: Owner, Admin and Member act as hub admin at most; Viewer and Finance act as viewer at most; Agent key acts as editor at most.',
    )
  })
})
