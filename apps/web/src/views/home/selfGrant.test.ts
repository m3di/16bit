import type { Me, WorkspaceRole } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { person } from '../../session/fixtures.test-utils.ts'
import { selfGranter } from './selfGrant.ts'

const as = (workspaceRole: WorkspaceRole): Me => ({
  ...(person as Extract<Me, { kind: 'person' }>),
  memberships: [{ workspace: { id: 'w', name: 'W' }, principalId: 'p', workspaceRole }],
})

describe('selfGranter (can grant.set, D45)', () => {
  it('lets owners and admins give themselves access, as themselves', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(selfGranter(as(role), 'w'), role).toEqual({
        id: 'p',
        kind: 'user',
        workspaceRole: role,
      })
    }
  })

  it('nobody else, not outside the reader’s workspaces, and not signed out', () => {
    for (const role of ['member', 'viewer', 'finance'] as const) {
      expect(selfGranter(as(role), 'w'), role).toBe(null)
    }
    expect(selfGranter(as('owner'), 'other')).toBe(null)
    expect(selfGranter(null, 'w')).toBe(null)
  })
})
