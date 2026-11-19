import type { Principal, Subject, WorkspaceRole } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import {
  canListInvites,
  canManage,
  canRevokeInvite,
  inviteRoles,
  lockedReason,
  ownerCount,
  peopleSummary,
  removeState,
  roleChoices,
  shortDate,
  viewerSummary,
} from './members.ts'

const person = (id: string, workspaceRole: WorkspaceRole): Principal => ({
  workspaceId: 'w',
  id,
  kind: 'user',
  name: id,
  workspaceRole,
})
const as = (role: WorkspaceRole, id = 'me'): Subject => ({ id, kind: 'user', workspaceRole: role })

const sara = person('sara', 'owner')
const omar = person('omar', 'owner')
const tomas = person('tomas', 'member')

describe('roleChoices (docs/ROLES.md, workspace table)', () => {
  it('lets an owner give any role, owner included', () => {
    expect(roleChoices(as('owner'), tomas, 1)).toEqual([
      'owner',
      'admin',
      'member',
      'viewer',
      'finance',
    ])
  })

  it('lets an admin give any role but owner', () => {
    expect(roleChoices(as('admin'), tomas, 1)).toEqual(['admin', 'member', 'viewer', 'finance'])
  })

  it('shows an owner read-only to an admin', () => {
    expect(roleChoices(as('admin'), sara, 2)).toEqual(['owner'])
    expect(lockedReason(as('admin'), sara, 2)).toBe('Only owners change owners')
  })

  it('never lets the last owner stop being one', () => {
    expect(roleChoices(as('owner', 'sara'), sara, 1)).toEqual(['owner'])
    expect(lockedReason(as('owner', 'sara'), sara, 1)).toBe('The only owner')
    // With a second owner, either may step down.
    expect(roleChoices(as('owner', 'sara'), sara, 2)).toHaveLength(5)
    expect(lockedReason(as('owner', 'sara'), omar, 2)).toBe('')
  })

  it('gives members, viewers and finance nothing to change, and no reasons per row', () => {
    for (const role of ['member', 'viewer', 'finance'] as const) {
      expect(canManage(as(role))).toBe(false)
      expect(roleChoices(as(role), tomas, 1)).toEqual(['member'])
      expect(lockedReason(as(role), sara, 1)).toBe('')
      expect(removeState(as(role), tomas, 1)).toBeNull()
    }
  })

  it('gives an unknown reader nothing', () => {
    expect(canManage(null)).toBe(false)
    expect(roleChoices(null, tomas, 1)).toEqual(['member'])
    expect(removeState(null, tomas, 1)).toBeNull()
    expect(inviteRoles(null)).toEqual([])
  })
})

describe('removeState', () => {
  it('lets owners and admins remove members', () => {
    expect(removeState(as('owner'), tomas, 1)).toEqual({ kind: 'allowed' })
    expect(removeState(as('admin'), tomas, 1)).toEqual({ kind: 'allowed' })
  })

  it('offers an admin nothing on an owner', () => {
    expect(removeState(as('admin'), sara, 2)).toBeNull()
  })

  it('refuses the last owner with a reason, and allows one of two', () => {
    const refused = removeState(as('owner', 'sara'), sara, 1)
    expect(refused?.kind).toBe('refused')
    expect(refused && 'reason' in refused ? refused.reason : '').toMatch(/one owner/)
    expect(removeState(as('owner', 'sara'), omar, 2)).toEqual({ kind: 'allowed' })
  })
})

describe('invites', () => {
  it('owners invite as any role, admins as any but owner, others not at all', () => {
    expect(inviteRoles(as('owner'))).toEqual(['owner', 'admin', 'member', 'viewer', 'finance'])
    expect(inviteRoles(as('admin'))).toEqual(['admin', 'member', 'viewer', 'finance'])
    for (const role of ['member', 'viewer', 'finance'] as const) {
      expect(inviteRoles(as(role))).toEqual([])
      expect(canListInvites(as(role))).toBe(false)
    }
  })

  it('lists for owners and admins; an admin cannot revoke an owner-role invite', () => {
    expect(canListInvites(as('owner'))).toBe(true)
    expect(canListInvites(as('admin'))).toBe(true)
    expect(canRevokeInvite(as('owner'), 'owner')).toBe(true)
    expect(canRevokeInvite(as('admin'), 'owner')).toBe(false)
    expect(canRevokeInvite(as('admin'), 'member')).toBe(true)
    expect(canRevokeInvite(as('member'), 'member')).toBe(false)
  })
})

describe('words', () => {
  it('counts owners', () => {
    expect(ownerCount([sara, omar, tomas])).toBe(2)
  })

  it('summarises people and pending invites', () => {
    expect(peopleSummary(7, 1)).toBe('7 people, 1 invite pending')
    expect(peopleSummary(1, 2)).toBe('1 person, 2 invites pending')
    expect(peopleSummary(3, 0)).toBe('3 people')
    expect(peopleSummary(3, null)).toBe('3 people')
  })

  it('says who the reader is', () => {
    expect(viewerSummary('owner')).toMatch(/^You own this workspace\./)
    expect(viewerSummary('admin')).toMatch(/^You are an admin/)
    expect(viewerSummary('member')).toMatch(/^You are a member.*Only owners and admins/)
    expect(viewerSummary('finance')).toMatch(/finance role/)
  })

  it('writes short dates, with the year only when it differs', () => {
    const now = new Date('2026-11-19T12:00:00Z')
    expect(shortDate('2026-11-14T12:00:00Z', now)).toBe('Nov 14')
    expect(shortDate('2027-01-02T12:00:00Z', now)).toBe('Jan 2, 2027')
  })
})
