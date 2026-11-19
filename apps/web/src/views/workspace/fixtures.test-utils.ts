import type { Invite, Me, Principal, WorkspaceRole } from '@16bit/core'
import type { Fetch } from '../../api/client.ts'
import { json } from '../../session/fixtures.test-utils.ts'

export const WS = 'w1'

export const member = (id: string, name: string, workspaceRole: WorkspaceRole): Principal => ({
  workspaceId: WS,
  id,
  kind: 'user',
  name,
  workspaceRole,
})

export const invite = (id: string, workspaceRole: WorkspaceRole, createdBy = 'p-sara'): Invite => ({
  workspaceId: WS,
  id,
  workspaceRole,
  createdBy,
  createdAt: '2026-11-14T10:00:00.000Z',
  expiresAt: '2026-11-21T10:00:00.000Z',
})

export const people = [
  member('p-sara', 'Sara', 'owner'),
  member('p-priya', 'Priya', 'admin'),
  member('p-tomas', 'Tomas', 'member'),
  member('p-omar', 'Omar', 'viewer'),
]

export const meAs = (principalId: string, workspaceRole: WorkspaceRole): Me => ({
  kind: 'person',
  account: { id: `acc-${principalId}`, email: 'x@example.com', name: principalId },
  memberships: [{ workspace: { id: WS, name: 'Parcel Tracker' }, principalId, workspaceRole }],
  truncated: false,
})

export type Handler = (body: unknown) => Response | Promise<Response>

/** A fake API keyed by `METHOD /path` without the query string. Anything else is a 404. */
export function fakeApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const fetchFn: Fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.split('?')[0] ?? url
    const method = init?.method ?? 'GET'
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    const route = routes[`${method} ${path}`]
    return route ? route(body) : json({ error: 'not_found', message: 'Route not found' }, 404)
  }
  return { fetchFn, calls }
}
