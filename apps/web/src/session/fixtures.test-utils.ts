import type { Me } from '@16bit/core'
import type { Fetch } from '../api/client.ts'

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export const person: Me = {
  kind: 'person',
  account: { id: 'acc-ada', email: 'ada@example.com', name: 'Ada Lovelace' },
  memberships: [
    {
      workspace: { id: 'w1', name: 'Parcel Tracker' },
      principalId: 'p-ada',
      workspaceRole: 'owner',
    },
  ],
  truncated: false,
}

export interface Call {
  method: string
  path: string
  body: unknown
}

/** A fake API keyed by `METHOD /path`. Records every call. Anything else is a 404. */
export function fakeApi(routes: Record<string, () => Response>) {
  const calls: Call[] = []
  const fetchFn: Fetch = (input, init) => {
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    const method = init?.method ?? 'GET'
    calls.push({
      method,
      path,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const route = routes[`${method} ${path}`]
    return Promise.resolve(
      route ? route() : json({ error: 'not_found', message: 'Route not found' }, 404),
    )
  }
  return { fetchFn, calls }
}
