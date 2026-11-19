import { itemSchema, workspacePageSchema } from '@16bit/core'
import { describe, expect, it, vi } from 'vitest'
import {
  ApiRequestError,
  getAllPages,
  getJson,
  MAX_PAGES,
  noContent,
  sendJson,
  setUnauthorizedHandler,
  type Fetch,
} from './client.ts'

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

  it('sends a DELETE without a body', async () => {
    const fetchFn = vi.fn<Fetch>(() => Promise.resolve(new Response(null, { status: 204 })))
    await expect(sendJson('DELETE', '/v1/m', undefined, noContent, fetchFn)).resolves.toBe(
      undefined,
    )
    const init = fetchFn.mock.calls[0]?.[1]
    expect(init?.method).toBe('DELETE')
    expect(init?.body).toBeUndefined()
    expect(init?.headers).not.toHaveProperty('Content-Type')
  })

  it('keeps the error body, so a conflict carries the current item', async () => {
    const fetchFn: Fetch = () =>
      Promise.resolve(json({ error: 'conflict', message: 'Changed', current: item }, 409))
    const error = await sendJson('PATCH', '/v1/i', {}, itemSchema, fetchFn).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'conflict', status: 409 })
    expect((error as ApiRequestError).body).toMatchObject({ current: item })
  })
})

describe('status helpers', () => {
  it('tells 401, 403 and 404 apart', () => {
    const at = (status: number) => new ApiRequestError('internal', 'x', status)
    expect(at(401)).toMatchObject({ isUnauthorized: true, isNoPermission: true, isNotFound: false })
    expect(at(403)).toMatchObject({
      isUnauthorized: false,
      isNoPermission: true,
      isNotFound: false,
    })
    expect(at(404)).toMatchObject({
      isUnauthorized: false,
      isNoPermission: false,
      isNotFound: true,
    })
  })
})

describe('unauthorized handler', () => {
  const unauthorized: Fetch = () =>
    Promise.resolve(json({ error: 'unauthorized', message: 'Sign in' }, 401))

  it('is called on a 401, and the request still fails', async () => {
    const handler = vi.fn()
    const remove = setUnauthorizedHandler(handler)
    try {
      await expect(
        getJson('/v1/workspaces', workspacePageSchema, unauthorized),
      ).rejects.toMatchObject({ code: 'unauthorized' })
      await expect(sendJson('PATCH', '/v1/i', {}, itemSchema, unauthorized)).rejects.toThrow()
      expect(handler).toHaveBeenCalledTimes(2)
    } finally {
      remove()
    }
  })

  it('is not called for quiet requests or other statuses', async () => {
    const handler = vi.fn()
    const remove = setUnauthorizedHandler(handler)
    try {
      await getJson('/v1/me', workspacePageSchema, unauthorized, { quiet401: true }).catch(
        () => null,
      )
      const forbidden: Fetch = () =>
        Promise.resolve(json({ error: 'forbidden', message: 'No' }, 403))
      await getJson('/v1/x', workspacePageSchema, forbidden).catch(() => null)
      expect(handler).not.toHaveBeenCalled()
    } finally {
      remove()
    }
  })

  it('is removed by the function it returns', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)()
    await getJson('/v1/x', workspacePageSchema, unauthorized).catch(() => null)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('noContent', () => {
  it('accepts a 204 without a body', async () => {
    const fetchFn: Fetch = () => Promise.resolve(new Response(null, { status: 204 }))
    await expect(
      sendJson('POST', '/v1/auth/logout', {}, noContent, fetchFn),
    ).resolves.toBeUndefined()
  })
})
