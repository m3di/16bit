import type { Me, WorkspaceRole } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { fakeApi, json, person } from '../../session/fixtures.test-utils.ts'
import { PALETTE_COLORS } from '../../ui/index.ts'
import { canCreateHub, createHub, hubRequest, nextHubColor, suggestPrefix } from './newHub.ts'

const as = (workspaceRole: WorkspaceRole): Me => ({
  ...(person as Extract<Me, { kind: 'person' }>),
  memberships: [{ workspace: { id: 'w', name: 'W' }, principalId: 'p', workspaceRole }],
})

const created = {
  access: 'granted',
  hubRole: 'hub_admin',
  workspaceId: 'w',
  id: 'h-new',
  hubId: 'h-new',
  parentId: null,
  name: 'Engineering',
  color: 'teal',
  idPrefix: 'ENG',
  itemCount: 0,
  version: 1,
}

describe('canCreateHub', () => {
  it('lets owners and admins create hubs, nobody else', () => {
    expect(canCreateHub(as('owner'), 'w')).toBe(true)
    expect(canCreateHub(as('admin'), 'w')).toBe(true)
    for (const role of ['member', 'viewer', 'finance'] as const) {
      expect(canCreateHub(as(role), 'w')).toBe(false)
    }
  })

  it('refuses outside the reader’s workspaces, and when signed out', () => {
    expect(canCreateHub(as('owner'), 'other')).toBe(false)
    expect(canCreateHub(null, 'w')).toBe(false)
  })
})

describe('suggestPrefix', () => {
  it('takes three letters of one word, or the initials of several', () => {
    expect(suggestPrefix('Engineering')).toBe('ENG')
    expect(suggestPrefix('customer support')).toBe('CS')
    expect(suggestPrefix('Road map for the year')).toBe('RMFT')
  })

  it('drops accents, symbols and leading digits', () => {
    expect(suggestPrefix('Équipe')).toBe('EQU')
    expect(suggestPrefix('2026 plan')).toBe('P')
    expect(suggestPrefix('42')).toBe('')
    expect(suggestPrefix('   ')).toBe('')
  })
})

describe('nextHubColor', () => {
  it('picks the first colour no hub uses yet', () => {
    expect(nextHubColor([], PALETTE_COLORS)).toBe(PALETTE_COLORS[0])
    expect(nextHubColor([PALETTE_COLORS[0], PALETTE_COLORS[1]], PALETTE_COLORS)).toBe(
      PALETTE_COLORS[2],
    )
    expect(nextHubColor(PALETTE_COLORS, PALETTE_COLORS)).toBe(PALETTE_COLORS[0])
  })
})

describe('hubRequest', () => {
  it('trims the name and sends the prefix in capitals', () => {
    expect(hubRequest({ name: '  Engineering ', idPrefix: ' eng ', color: 'teal' })).toEqual({
      ok: true,
      body: { name: 'Engineering', idPrefix: 'ENG', color: 'teal' },
    })
  })

  it('names every field that stops the create', () => {
    expect(hubRequest({ name: ' ', idPrefix: '', color: null })).toEqual({
      ok: false,
      errors: {
        name: 'Name the hub.',
        idPrefix: 'Choose an ID prefix.',
        color: 'Choose a colour.',
      },
    })
    expect(hubRequest({ name: 'x'.repeat(201), idPrefix: 'E', color: 'teal' })).toEqual({
      ok: false,
      errors: { name: 'Use at most 200 characters.' },
    })
  })

  it('refuses a prefix the contract would refuse', () => {
    for (const idPrefix of ['1AB', 'A-B', 'ABCDEFGHIJK']) {
      const result = hubRequest({ name: 'Ops', idPrefix, color: 'teal' })
      expect(result).toEqual({
        ok: false,
        errors: { idPrefix: 'Start with a letter, then use up to 9 letters or digits.' },
      })
    }
  })
})

describe('createHub', () => {
  const body = { name: 'Engineering', idPrefix: 'ENG', color: 'teal' } as const

  it('posts the hub and returns it with the reader as hub admin', async () => {
    const api = fakeApi({ 'POST /v1/workspaces/w/hubs': () => json(created, 201) })
    const result = await createHub('w', body, api.fetchFn)
    expect(result).toEqual({ ok: true, hub: created })
    expect(api.calls).toEqual([{ method: 'POST', path: '/v1/workspaces/w/hubs', body }])
  })

  it('says why a create was refused', async () => {
    const cases: [number, string, string][] = [
      [403, 'forbidden', 'Your role does not allow creating hubs in this workspace.'],
      [404, 'not_found', 'This workspace is no longer available.'],
      [409, 'id_taken', 'That hub ID is already used. Try again.'],
      [500, 'internal', 'The hub was not created. Boom'],
    ]
    for (const [status, error, message] of cases) {
      const api = fakeApi({
        'POST /v1/workspaces/w/hubs': () => json({ error, message: 'Boom' }, status),
      })
      expect(await createHub('w', body, api.fetchFn)).toEqual({ ok: false, message })
    }
  })

  it('says when the server cannot be reached', async () => {
    const result = await createHub('w', body, () => Promise.reject(new Error('offline')))
    expect(result).toEqual({
      ok: false,
      message: 'The hub was not created. The server could not be reached.',
    })
  })
})
