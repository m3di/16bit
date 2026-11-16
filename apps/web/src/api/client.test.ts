import { itemSchema, workspacePageSchema } from '@16bit/core'
import { describe, expect, it, vi } from 'vitest'
import { ApiRequestError, getAllPages, getJson, MAX_PAGES, sendJson, type Fetch } from './client.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The URL a fake fetch was called with. */
const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

const ws = (id: string) => ({ id, name: id, createdAt: '2026-11-16T00:00:00.000Z' })

describe('getJson', () => {
  it('returns the parsed body', async () => {
    const fetchFn = vi.fn<Fetch>(() =>
      Promise.resolve(json({ items: [ws('a')], nextCursor: null })),
    )
    expect(await getJson('/v1/workspaces', workspacePageSchema, fetchFn)).toEqual({
      items: [ws('a')],
      nextCursor: null,
    })
  })

  it('carries the API error code, message, and status', async () => {
    const fetchFn: Fetch = () =>
      Promise.resolve(
        json({ error: 'unauthorized', message: 'A valid bearer token is required' }, 401),
      )
    const error = await getJson('/v1/workspaces', workspacePageSchema, fetchFn).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ code: 'unauthorized', status: 401, isNoPermission: true })
  })

  it('reads a non-JSON failure as internal', async () => {
    const fetchFn: Fetch = () => Promise.resolve(new Response('Bad gateway', { status: 502 }))
    await expect(getJson('/v1/x', workspacePageSchema, fetchFn)).rejects.toMatchObject({
      code: 'internal',
      status: 502,
      isNoPermission: false,
    })
  })

  it('reports a failed connection as a network error', async () => {
    const fetchFn: Fetch = () => Promise.reject(new TypeError('Failed to fetch'))
    await expect(getJson('/v1/x', workspacePageSchema, fetchFn)).rejects.toMatchObject({
      code: 'network',
      status: 0,
    })
  })

  it('rejects a body that breaks the contract', async () => {
    const fetchFn: Fetch = () => Promise.resolve(json({ items: 'nope' }))
    await expect(getJson('/v1/x', workspacePageSchema, fetchFn)).rejects.toMatchObject({
      code: 'bad_response',
    })
  })
})

describe('getAllPages', () => {
  it('follows cursors until the last page', async () => {
    const fetchFn = vi.fn<Fetch>((input) => {
      const url = new URL(urlOf(input), 'http://x')
      return Promise.resolve(
        url.searchParams.get('cursor') === 'c1'
          ? json({ items: [ws('b')], nextCursor: null })
          : json({ items: [ws('a')], nextCursor: 'c1' }),
      )
    })
    const all = await getAllPages('/v1/workspaces', workspacePageSchema, fetchFn)
    expect(all.map((w) => w.id)).toEqual(['a', 'b'])
    expect(fetchFn.mock.calls.map(([input]) => urlOf(input))).toEqual([
      '/v1/workspaces?limit=200',
      '/v1/workspaces?limit=200&cursor=c1',
    ])
  })

  it('stops a list that never ends', async () => {
    const fetchFn = vi.fn<Fetch>(() => Promise.resolve(json({ items: [], nextCursor: 'again' })))
    await expect(getAllPages('/v1/x', workspacePageSchema, fetchFn)).rejects.toMatchObject({
      code: 'bad_response',
    })
    expect(fetchFn).toHaveBeenCalledTimes(MAX_PAGES)
  })

  it('keeps a query string already on the path', async () => {
    const fetchFn = vi.fn<Fetch>((input) => {
      const url = new URL(urlOf(input), 'http://x')
      return Promise.resolve(
        url.searchParams.get('cursor') === 'c1'
          ? json({ items: [ws('b')], nextCursor: null })
          : json({ items: [ws('a')], nextCursor: 'c1' }),
      )
    })
    await getAllPages('/v1/x?folder=f1', workspacePageSchema, fetchFn)
    expect(fetchFn.mock.calls.map(([input]) => urlOf(input))).toEqual([
      '/v1/x?folder=f1&limit=200',
      '/v1/x?folder=f1&limit=200&cursor=c1',
    ])
  })

  it('respects a limit the caller set', async () => {
    const fetchFn = vi.fn<Fetch>(() => Promise.resolve(json({ items: [], nextCursor: null })))
    await getAllPages('/v1/x?limit=10', workspacePageSchema, fetchFn)
    expect(urlOf(fetchFn.mock.calls[0]?.[0] ?? '')).toBe('/v1/x?limit=10')
  })
})

const item = {
  workspaceId: 'w',
  id: 'i1',
  hubId: 'h',
  folderId: 'h',
  seqId: 1,
  values: {},
  version: 2,
  updatedAt: '2026-11-16T00:00:00.000Z',
  updatedBy: 'p',
}

describe('sendJson', () => {
  it('sends the body as JSON with the method', async () => {
    const fetchFn = vi.fn<Fetch>(() => Promise.resolve(json(item)))
    expect(await sendJson('PATCH', '/v1/i', { version: 1 }, itemSchema, fetchFn)).toEqual(item)
    const init = fetchFn.mock.calls[0]?.[1]
    expect(init?.method).toBe('PATCH')
    expect(init?.body).toBe('{"version":1}')
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' })
  })

  it('keeps the error body, so a conflict carries the current item', async () => {
    const fetchFn: Fetch = () =>
      Promise.resolve(json({ error: 'conflict', message: 'Changed', current: item }, 409))
    const error = await sendJson('PATCH', '/v1/i', {}, itemSchema, fetchFn).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'conflict', status: 409 })
    expect((error as ApiRequestError).body).toMatchObject({ current: item })
  })
})
