import type { AgentKey, HubGrantEntry, Principal } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { fakeApi, json, type Call } from '../hub/fixtures.test-utils.ts'
import { HUB, WS } from './fixtures.test-utils.ts'
import { useHubAccess } from './useHubAccess.ts'

const base = `/v1/workspaces/${WS}`
const hubPath = `${base}/hubs/${HUB}`

const grants = (): HubGrantEntry[] => [
  { principalId: 'kofi', kind: 'user', name: 'Kofi', workspaceRole: 'member', hubRole: 'editor' },
  {
    principalId: 'p-sara',
    kind: 'user',
    name: 'Sara',
    workspaceRole: 'owner',
    hubRole: 'hub_admin',
  },
  { principalId: 'tomas', kind: 'user', name: 'Tomas', workspaceRole: 'member', hubRole: 'viewer' },
]

const members = (): Principal[] => [
  { workspaceId: WS, id: 'lena', kind: 'user', name: 'Lena', workspaceRole: 'member' },
]

const key = (id: string, revokedAt: string | null = null): AgentKey => ({
  workspaceId: WS,
  id,
  name: id,
  hubId: HUB,
  hubRole: 'editor',
  createdBy: 'p-sara',
  createdAt: '2026-11-01T00:00:00.000Z',
  expiresAt: null,
  revokedAt,
})

const grantOf = (principalId: string, hubRole: string) => ({
  workspaceId: WS,
  hubId: HUB,
  principalId,
  hubRole,
})

async function setup(routes: Record<string, (call: Call) => Response> = {}) {
  const { fetchFn, calls } = fakeApi((call) => {
    const route = routes[`${call.method} ${call.path.replace(/\?.*$/, '')}`]
    if (route) return route(call)
    if (call.path.startsWith(`${hubPath}/grants?`))
      return json({ items: grants(), nextCursor: null })
    if (call.path.startsWith(`${base}/members?`))
      return json({ items: members(), nextCursor: null })
    if (call.path.startsWith(`${hubPath}/agent-keys?`))
      return json({ items: [key('k1')], nextCursor: null })
    return json({ error: 'not_found', message: 'Route not found' }, 404)
  })
  const access = useHubAccess(WS, HUB, fetchFn)
  await access.loadGrants()
  const rows = () => (access.grants.value.state === 'ready' ? access.grants.value.data : [])
  const writes = () => calls.filter((c) => c.method !== 'GET')
  return { access, calls, rows, writes }
}

describe('changing a hub role', () => {
  it('shows at once and keeps the saved role', async () => {
    const { access, rows, writes } = await setup({
      [`PUT ${hubPath}/grants/kofi`]: () => json(grantOf('kofi', 'commenter')),
    })
    const done = access.changeRole('kofi', 'commenter')
    expect(rows()[0]?.hubRole).toBe('commenter')
    expect(await done).toBe(true)
    expect(writes()).toEqual([
      { method: 'PUT', path: `${hubPath}/grants/kofi`, body: { hubRole: 'commenter' } },
    ])
  })

  it('rolls back with the reason when refused, and reads the list again on a 403', async () => {
    const { access, rows, calls } = await setup({
      [`PUT ${hubPath}/grants/kofi`]: () => json({ error: 'forbidden', message: 'No' }, 403),
    })
    expect(await access.changeRole('kofi', 'hub_admin')).toBe(false)
    expect(rows()[0]?.hubRole).toBe('editor')
    expect(access.notice.value).toBe(
      "Kofi's access was not changed to Hub admin. Your role does not allow this.",
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.filter((c) => c.path.startsWith(`${hubPath}/grants?`))).toHaveLength(2)
  })
})

describe('revoking access', () => {
  it('removes the row at once', async () => {
    const { access, rows, writes } = await setup({
      [`DELETE ${hubPath}/grants/tomas`]: () => new Response(null, { status: 204 }),
    })
    const done = access.revoke('tomas')
    expect(rows().map((g) => g.principalId)).toEqual(['kofi', 'p-sara'])
    expect(await done).toBe(true)
    expect(writes()).toEqual([
      { method: 'DELETE', path: `${hubPath}/grants/tomas`, body: undefined },
    ])
  })

  it('puts the row back where it was when refused', async () => {
    const { access, rows } = await setup({
      [`DELETE ${hubPath}/grants/kofi`]: () => json({ error: 'internal', message: 'Boom' }, 500),
    })
    expect(await access.revoke('kofi')).toBe(false)
    expect(rows().map((g) => g.principalId)).toEqual(['kofi', 'p-sara', 'tomas'])
    expect(access.notice.value).toBe("Kofi's access was not revoked. Boom")
  })
})

describe('adding someone', () => {
  it('grants and lists them by name', async () => {
    const { access, rows, writes } = await setup({
      [`PUT ${hubPath}/grants/lena`]: () => json(grantOf('lena', 'editor')),
    })
    const lena = members()[0]
    if (!lena) throw new Error('fixture')
    await access.add(lena, 'editor')
    expect(writes()[0]).toEqual({
      method: 'PUT',
      path: `${hubPath}/grants/lena`,
      body: { hubRole: 'editor' },
    })
    expect(rows().map((g) => g.name)).toEqual(['Kofi', 'Lena', 'Sara', 'Tomas'])
  })

  it('throws a refusal for the dialog and changes nothing', async () => {
    const { access, rows } = await setup({
      [`PUT ${hubPath}/grants/lena`]: () => json({ error: 'forbidden', message: 'No' }, 403),
    })
    const lena = members()[0]
    if (!lena) throw new Error('fixture')
    await expect(access.add(lena, 'editor')).rejects.toMatchObject({ status: 403 })
    expect(rows()).toHaveLength(3)
  })
})

describe('agent keys', () => {
  it('creates a key, lists it first, and reads the grants again', async () => {
    const created = { key: key('k2'), secret: '16b_secret' }
    const { access, calls, writes } = await setup({
      [`POST ${hubPath}/agent-keys`]: () => json(created, 201),
    })
    await access.loadKeys()
    const answer = await access.createKey({ name: 'k2', hubRole: 'editor', expiresAt: null })
    expect(answer.secret).toBe('16b_secret')
    expect(writes()[0]?.body).toEqual({ name: 'k2', hubRole: 'editor', expiresAt: null })
    expect(access.keys.value.state === 'ready' && access.keys.value.data.map((k) => k.id)).toEqual([
      'k2',
      'k1',
    ])
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.filter((c) => c.path.startsWith(`${hubPath}/grants?`))).toHaveLength(2)
  })

  it('revokes a key and shows it revoked', async () => {
    const { access } = await setup({
      [`POST ${base}/agent-keys/k1/revoke`]: () => json(key('k1', '2026-11-19T00:00:00.000Z')),
    })
    await access.loadKeys()
    await access.revokeKey('k1')
    expect(access.keys.value.state === 'ready' && access.keys.value.data[0]?.revokedAt).toBe(
      '2026-11-19T00:00:00.000Z',
    )
  })

  it('a refused revoke throws and leaves the key as it was', async () => {
    const { access } = await setup({
      [`POST ${base}/agent-keys/k1/revoke`]: () => json({ error: 'forbidden', message: 'No' }, 403),
    })
    await access.loadKeys()
    await expect(access.revokeKey('k1')).rejects.toMatchObject({ status: 403 })
    expect(access.keys.value.state === 'ready' && access.keys.value.data[0]?.revokedAt).toBeNull()
  })
})
