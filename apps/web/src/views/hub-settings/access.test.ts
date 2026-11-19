import type { AgentKey, AgentKeyState, HubGrantEntry, Subject, WorkspaceRole } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import {
  canEditGeneral,
  canListGrants,
  canListKeys,
  canRevokeGrant,
  canRevokeKey,
  cappedNote,
  deleteHubState,
  grantRoleChoices,
  itemTotal,
  keyExpiry,
  keyRoleChoices,
  keyStatus,
  lockedGrantReason,
  newGrantRoles,
  sourceLabel,
  titleChoices,
  viewerOf,
} from './access.ts'
import { description, meAs, WS } from './fixtures.test-utils.ts'

const as = (workspaceRole: WorkspaceRole, id = 'p-sara'): Subject => ({
  id,
  kind: 'user',
  workspaceRole,
})

const grant = (
  principalId: string,
  workspaceRole: WorkspaceRole,
  hubRole: HubGrantEntry['hubRole'],
  kind: HubGrantEntry['kind'] = 'user',
  keyState: AgentKeyState = 'active',
): HubGrantEntry => {
  const base = { principalId, name: principalId, workspaceRole, hubRole }
  return kind === 'agent' ? { ...base, kind, keyState } : { ...base, kind }
}

describe('the reader', () => {
  it('is a subject in this workspace, never an agent or another workspace', () => {
    expect(viewerOf(meAs('admin'), WS)).toEqual(as('admin'))
    expect(viewerOf(meAs('admin'), 'elsewhere')).toBeNull()
    expect(viewerOf(null, WS)).toBeNull()
  })
})

describe('general settings', () => {
  it('are changed by hub admins only, whatever the workspace role', () => {
    expect(canEditGeneral(as('member'), 'hub_admin')).toBe(true)
    expect(canEditGeneral(as('owner'), 'editor')).toBe(false)
    expect(canEditGeneral(as('member'), 'viewer')).toBe(false)
    expect(canEditGeneral(null, 'hub_admin')).toBe(false)
  })

  it('offer only text attributes as the title (D50)', () => {
    expect(titleChoices(description()).map((a) => a.id)).toEqual(['title'])
  })

  it('say the item total counts every folder', () => {
    expect(itemTotal(1)).toBe('1 item in this hub, counting every folder.')
    expect(itemTotal(1280)).toBe('1,280 items in this hub, counting every folder.')
  })
})

describe('access', () => {
  it('is listed by hub admins, owners and admins (docs/ROLES.md)', () => {
    expect(canListGrants(as('member'), 'hub_admin')).toBe(true)
    expect(canListGrants(as('owner'), 'viewer')).toBe(true)
    expect(canListGrants(as('admin'), 'editor')).toBe(true)
    expect(canListGrants(as('member'), 'editor')).toBe(false)
    expect(canListGrants(as('viewer'), 'viewer')).toBe(false)
  })

  it('a hub admin changes members, not themselves, owners, admins or agents (³)', () => {
    const me = as('member')
    expect(grantRoleChoices(me, 'hub_admin', grant('tomas', 'member', 'editor'))).toEqual([
      'hub_admin',
      'editor',
      'commenter',
      'viewer',
    ])
    for (const target of [
      grant('p-sara', 'member', 'hub_admin'),
      grant('own', 'owner', 'editor'),
      grant('adm', 'admin', 'editor'),
      grant('bot', 'member', 'editor', 'agent'),
    ]) {
      expect(grantRoleChoices(me, 'hub_admin', target), target.principalId).toEqual([
        target.hubRole,
      ])
      expect(canRevokeGrant(me, 'hub_admin', target), target.principalId).toBe(false)
    }
    expect(lockedGrantReason(me, 'hub_admin', grant('p-sara', 'member', 'hub_admin'))).toBe(
      'Your own access',
    )
    expect(lockedGrantReason(me, 'hub_admin', grant('bot', 'member', 'editor', 'agent'))).toBe(
      'Set by its key',
    )
    expect(lockedGrantReason(me, 'hub_admin', grant('own', 'owner', 'editor'))).toBe(
      'Only owners change owners',
    )
  })

  it("an admin changes anyone's but an owner's, their own included (¹)", () => {
    const me = as('admin')
    expect(grantRoleChoices(me, 'editor', grant('p-sara', 'admin', 'editor'))).toHaveLength(4)
    expect(canRevokeGrant(me, 'editor', grant('p-sara', 'admin', 'editor'))).toBe(true)
    expect(grantRoleChoices(me, 'editor', grant('own', 'owner', 'viewer'))).toEqual(['viewer'])
    expect(canRevokeGrant(me, 'editor', grant('own', 'owner', 'viewer'))).toBe(false)
    expect(canRevokeGrant(as('owner'), 'viewer', grant('own', 'owner', 'viewer'))).toBe(true)
  })

  it('an editor or viewer changes nothing', () => {
    expect(grantRoleChoices(as('member'), 'editor', grant('t', 'member', 'viewer'))).toEqual([
      'viewer',
    ])
    expect(newGrantRoles(as('member'), 'editor', as('member', 't'))).toEqual([])
    expect(lockedGrantReason(as('member'), 'editor', grant('t', 'member', 'viewer'))).toBe('')
  })

  it('notes when a role acts lower than granted, and where access comes from', () => {
    expect(cappedNote(grant('ivy', 'viewer', 'editor'))).toBe('Acts as viewer')
    expect(cappedNote(grant('noor', 'finance', 'viewer'))).toBe('')
    expect(cappedNote(grant('tomas', 'member', 'editor'))).toBe('')
    expect(sourceLabel(grant('bot', 'member', 'editor', 'agent'))).toBe('Agent key')
    expect(sourceLabel(grant('bot', 'member', 'editor', 'agent', 'revoked'))).toBe(
      'Agent key, revoked',
    )
    expect(sourceLabel(grant('bot', 'member', 'editor', 'agent', 'expired'))).toBe(
      'Agent key, expired',
    )
    expect(sourceLabel(grant('own', 'owner', 'editor'))).toBe('Owner')
  })
})

describe('agent keys', () => {
  it('are listed by hub admins, and by owners and admins holding a grant', () => {
    expect(canListKeys(as('member'), 'hub_admin')).toBe(true)
    expect(canListKeys(as('owner'), 'viewer')).toBe(true)
    expect(canListKeys(as('member'), 'editor')).toBe(false)
  })

  it('get at most the creator’s own role (²), never hub admin', () => {
    expect(keyRoleChoices(as('member'), 'hub_admin')).toEqual(['editor', 'commenter', 'viewer'])
    expect(keyRoleChoices(as('owner'), 'viewer')).toEqual(['viewer'])
    expect(keyRoleChoices(as('admin'), 'commenter')).toEqual(['commenter', 'viewer'])
    expect(keyRoleChoices(as('member'), 'editor')).toEqual([])
  })

  it('are revoked by hub admins, owners and admins', () => {
    expect(canRevokeKey(as('member'), 'hub_admin')).toBe(true)
    expect(canRevokeKey(as('admin'), 'viewer')).toBe(true)
    expect(canRevokeKey(as('member'), 'editor')).toBe(false)
  })

  it('show whether they still work', () => {
    const key = (expiresAt: string | null, revokedAt: string | null): AgentKey => ({
      workspaceId: WS,
      id: 'k',
      name: 'bot',
      hubId: 'bld',
      hubRole: 'editor',
      createdBy: 'p-sara',
      createdAt: '2026-11-01T00:00:00.000Z',
      expiresAt,
      revokedAt,
    })
    const now = new Date('2026-11-19T00:00:00.000Z')
    expect(keyStatus(key(null, null), now)).toBe('active')
    expect(keyStatus(key('2026-11-18T00:00:00.000Z', null), now)).toBe('expired')
    expect(keyStatus(key(null, '2026-11-02T00:00:00.000Z'), now)).toBe('revoked')
    expect(keyExpiry('never', now)).toBeNull()
    expect(keyExpiry('30', now)).toBe('2026-12-19T00:00:00.000Z')
  })
})

describe('deleting the hub (D52)', () => {
  const empty = () => ({
    ...description(),
    hub: { ...description().hub, itemCount: 0 },
    folders: [],
  })

  it('is for owners and admins only', () => {
    expect(deleteHubState(as('member'), empty(), [])).toEqual({
      kind: 'refused',
      reason: 'Only workspace owners and admins delete hubs.',
    })
    expect(deleteHubState(as('owner'), empty(), null)).toEqual({ kind: 'allowed' })
  })

  it('an admin waits for the grant list, and is refused while an owner holds a grant', () => {
    expect(deleteHubState(as('admin'), empty(), null)).toEqual({ kind: 'waiting' })
    expect(deleteHubState(as('admin'), empty(), [grant('p-sara', 'admin', 'hub_admin')])).toEqual({
      kind: 'allowed',
    })
    expect(deleteHubState(as('admin'), empty(), [grant('own', 'owner', 'viewer')])).toEqual({
      kind: 'refused',
      reason: 'A workspace owner has access to this hub, so only an owner can delete it.',
    })
    // An agent with a grant is not an owner.
    expect(
      deleteHubState(as('admin'), empty(), [grant('bot', 'owner', 'viewer', 'agent')]).kind,
    ).toBe('allowed')
  })

  it('says what is still in the hub', () => {
    expect(deleteHubState(as('owner'), description(), null)).toEqual({
      kind: 'refused',
      reason: 'It still holds 5 items and 3 folders. Delete or move them first.',
    })
    const oneFolder = { ...empty(), folders: description().folders.slice(0, 1) }
    expect(deleteHubState(as('owner'), oneFolder, null)).toMatchObject({
      reason: 'It still holds 1 folder. Delete or move them first.',
    })
  })
})
