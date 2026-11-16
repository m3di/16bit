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

describe('useDashboard', () => {
  it('starts loading', () => {
    expect(useDashboard(api({})).workspaces.value.state).toBe('loading')
  })

  it('loads workspaces and their hubs', async () => {
    const d = useDashboard(
      api({
        '/v1/workspaces': () => page([ws('a'), ws('b')]),
        '/v1/workspaces/a/hubs': () => page([hub('a', 'h1', 412), hub('a', 'h2')]),
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

  it('keeps other workspaces when one fails, and retries it', async () => {
    let fail = true
    const d = useDashboard(
      api({
        '/v1/workspaces': () => page([ws('a'), ws('b')]),
        '/v1/workspaces/a/hubs': () => page([hub('a', 'h1')]),
        '/v1/workspaces/b/hubs': () =>
          fail
            ? json({ error: 'internal', message: 'Internal error' }, 500)
            : page([hub('b', 'h2')]),
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

  it('ignores a slower, older load', async () => {
    let release: (() => void) | undefined
    let calls = 0
    const d = useDashboard((input) => {
      const path = new URL(urlOf(input), 'http://x').pathname
      if (path !== '/v1/workspaces') return Promise.resolve(page([]))
      calls++
      if (calls === 1) {
        return new Promise((resolve) => {
          release = () => {
            resolve(page([ws('old')]))
          }
        })
      }
      return Promise.resolve(page([ws('new')]))
    })
    const first = d.load()
    await d.load()
    release?.()
    await first
    const value = d.workspaces.value
    if (value.state !== 'ready') throw new Error(value.state)
    expect(value.data.map((e) => e.workspace.id)).toEqual(['new'])
  })
})
