import type { Folder, PaletteColor } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import type { Fetch } from '../../api/client.ts'
import { useDashboard } from './useDashboard.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The URL a fake fetch was called with. */
const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

const ws = (id: string) => ({ id, name: `Workspace ${id}`, createdAt: '2026-11-16T00:00:00.000Z' })

const hub = (
  workspaceId: string,
  id: string,
  itemCount = 0,
  color: PaletteColor = 'teal',
): Folder => ({
  workspaceId,
  id,
  hubId: id,
  parentId: null,
  name: `Hub ${id}`,
  color,
  idPrefix: 'HUB',
  itemCount,
  version: 1,
})

/** A fake API: routes by path, everything else is a 404. */
function api(routes: Record<string, () => Response>): Fetch {
  return (input) => {
    const path = new URL(urlOf(input), 'http://x').pathname
    const route = routes[path]
    return Promise.resolve(
      route ? route() : json({ error: 'not_found', message: 'Route not found' }, 404),
    )
  }
}

const page = (items: unknown[]) => json({ items, nextCursor: null })

/** A hub as the hub list sends it to a caller holding a grant on it. */
const listed = (h: Folder) => ({ ...h, access: 'granted', hubRole: 'editor' })
const hubPage = (hubs: Folder[]) => page(hubs.map(listed))

describe('useDashboard', () => {
  it('starts loading', () => {
    expect(useDashboard(api({})).workspaces.value.state).toBe('loading')
  })

  it('loads workspaces and their hubs', async () => {
    const d = useDashboard(
      api({
        '/v1/workspaces': () => page([ws('a'), ws('b')]),
        '/v1/workspaces/a/hubs': () => hubPage([hub('a', 'h1', 412), hub('a', 'h2')]),
        '/v1/workspaces/b/hubs': () => page([]),
      }),
    )
    await d.load()
    const value = d.workspaces.value
    if (value.state !== 'ready') throw new Error(value.state)
    expect(value.data.map((e) => [e.workspace.id, e.hubs.state])).toEqual([
      ['a', 'ready'],
      ['b', 'ready'],
    ])
    expect(d.totals.value).toEqual({ hubs: 2, workspaces: 2 })
  })

  it('leaves out hubs the caller holds no grant on', async () => {
    const d = useDashboard(
      api({
        '/v1/workspaces': () => page([ws('a')]),
        '/v1/workspaces/a/hubs': () =>
          page([
            listed(hub('a', 'h1', 3)),
            { access: 'none', workspaceId: 'a', id: 'h2', name: 'Hub h2', color: 'teal' },
          ]),
      }),
    )
    await d.load()
    const value = d.workspaces.value
    if (value.state !== 'ready') throw new Error(value.state)
    expect(value.data[0]?.hubs).toEqual({ state: 'ready', data: [listed(hub('a', 'h1', 3))] })
  })

  it('keeps other workspaces when one fails, and retries it', async () => {
    let fail = true
    const d = useDashboard(
      api({
        '/v1/workspaces': () => page([ws('a'), ws('b')]),
        '/v1/workspaces/a/hubs': () => hubPage([hub('a', 'h1')]),
        '/v1/workspaces/b/hubs': () =>
          fail
            ? json({ error: 'internal', message: 'Internal error' }, 500)
            : hubPage([hub('b', 'h2')]),
      }),
    )
    await d.load()
    const value = d.workspaces.value
    if (value.state !== 'ready') throw new Error(value.state)
    expect(value.data[0]?.hubs.state).toBe('ready')
    expect(value.data[1]?.hubs).toMatchObject({
      state: 'error',
      error: { message: 'Internal error' },
    })
    expect(d.totals.value).toBeNull()

    fail = false
    await d.reloadHubs('b')
    expect(value.data[1]?.hubs.state).toBe('ready')
    expect(d.totals.value).toEqual({ hubs: 2, workspaces: 2 })
  })

  it('reports a refused key as no permission', async () => {
    const d = useDashboard(
      api({ '/v1/workspaces': () => json({ error: 'unauthorized', message: 'No' }, 401) }),
    )
    await d.load()
    expect(d.workspaces.value).toMatchObject({ state: 'error', error: { isNoPermission: true } })
  })

  it('reports an unreachable server as an error', async () => {
    const d = useDashboard(() => Promise.reject(new TypeError('Failed to fetch')))
    await d.load()
    expect(d.workspaces.value).toMatchObject({ state: 'error', error: { code: 'network' } })
  })

  it('joins a load that is already running instead of sending another', async () => {
    let release: (() => void) | undefined
    let calls = 0
    const d = useDashboard((input) => {
      const path = new URL(urlOf(input), 'http://x').pathname
      if (path !== '/v1/workspaces') return Promise.resolve(page([]))
      calls++
      return new Promise((resolve) => {
        release = () => {
          resolve(page([ws('a')]))
        }
      })
    })
    const first = d.load()
    const second = d.load()
    release?.()
    await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(d.workspaces.value.state).toBe('ready')

    // Once it has finished, a new load sends a new request.
    const third = d.load()
    release?.()
    await third
    expect(calls).toBe(2)
  })

  it('sends one hubs request for two quick retries', async () => {
    let hubCalls = 0
    const d = useDashboard(
      api({
        '/v1/workspaces': () => page([ws('a')]),
        '/v1/workspaces/a/hubs': () => {
          hubCalls++
          return page([])
        },
      }),
    )
    await d.load()
    hubCalls = 0
    await Promise.all([d.reloadHubs('a'), d.reloadHubs('a')])
    expect(hubCalls).toBe(1)
  })
})
