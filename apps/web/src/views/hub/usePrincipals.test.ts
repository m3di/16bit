import type { Me, Principal } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { fakeApi, json } from './fixtures.test-utils.ts'
import { usePrincipals } from './usePrincipals.ts'

const person = (id: string, name: string, kind: Principal['kind'] = 'user'): Principal => ({
  workspaceId: 'w',
  id,
  kind,
  name,
  workspaceRole: 'member',
})

const me: Me = {
  kind: 'person',
  account: { id: 'acc', email: 'ana@x.io', name: 'Ana' },
  memberships: [
    { workspace: { id: 'w', name: 'W' }, principalId: 'p-ana', workspaceRole: 'owner' },
  ],
  truncated: false,
}

describe('usePrincipals', () => {
  it('names actors from the member list, by name', async () => {
    const api = fakeApi(() =>
      json({ items: [person('p-zed', 'Zed'), person('p-bot', 'Bot', 'agent')], nextCursor: null }),
    )
    const p = usePrincipals('w', () => me, api.fetchFn)
    await p.load()
    expect(api.calls[0]?.path).toBe('/v1/workspaces/w/members?limit=200')
    expect(p.status.value).toEqual({ state: 'ready' })
    expect(p.actor('p-zed')).toEqual({ id: 'p-zed', name: 'Zed', kind: 'person', known: true })
    expect(p.actor('p-bot')).toMatchObject({ kind: 'agent', known: true })
    expect(p.choices.value.map((a) => a.name)).toEqual(['Ana', 'Bot', 'Zed'])
  })

  it('shows a short ID, never a made-up name, for someone it cannot name', async () => {
    const p = usePrincipals(
      'w',
      () => null,
      fakeApi(() => json({ items: [], nextCursor: null })).fetchFn,
    )
    await p.load()
    expect(p.actor('0123456789abcdef')).toEqual({
      id: '0123456789abcdef',
      name: '01234567',
      kind: 'person',
      known: false,
    })
  })

  it('falls back to the signed-in user when there is no member list yet', async () => {
    const api = fakeApi(() => json({ error: 'not_found', message: 'Not found' }, 404))
    const p = usePrincipals('w', () => me, api.fetchFn)
    await p.load()
    expect(p.status.value).toEqual({ state: 'unavailable' })
    expect(p.choices.value).toEqual([{ id: 'p-ana', name: 'Ana', kind: 'person' }])
    expect(p.actor('p-ana').known).toBe(true)
  })

  it('reports other failures so they can be retried', async () => {
    const api = fakeApi(() => json({ error: 'internal', message: 'Boom' }, 500))
    const p = usePrincipals('w', () => null, api.fetchFn)
    await p.load()
    expect(p.status.value.state).toBe('error')
  })
})
