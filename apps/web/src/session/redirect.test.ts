import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { getJson, noContent } from '../api/client.ts'
import { makeRouter } from '../router.ts'
import { installAuthRedirect } from './redirect.ts'
import { createSession } from './session.ts'
import { fakeApi, json, person } from './fixtures.test-utils.ts'

const unauthorized = () => json({ error: 'unauthorized', message: 'Session ended' }, 401)
let remove: (() => void) | null = null
afterEach(() => {
  remove?.()
  remove = null
})

async function setUp(path: string) {
  const router = makeRouter(createMemoryHistory())
  await router.push(path)
  await router.isReady()
  const { fetchFn } = fakeApi({ 'GET /v1/me': () => json(person), 'GET /v1/x': unauthorized })
  const session = createSession(fetchFn)
  await session.load()
  remove = installAuthRedirect(router, session)
  return { router, session, fetchFn }
}

describe('installAuthRedirect', () => {
  it('sends a 401 to sign-in, with the page to come back to', async () => {
    const { router, session, fetchFn } = await setUp('/w/w1/hubs/h1?item=i1')
    await getJson('/v1/x', noContent, fetchFn).catch(() => null)
    await vi.waitFor(() => {
      expect(router.currentRoute.value.name).toBe('sign-in')
    })
    expect(router.currentRoute.value.query).toEqual({ next: '/w/w1/hubs/h1?item=i1' })
    expect(session.me.value).toEqual({ state: 'ready', data: null })
  })

  it('leaves public pages where they are', async () => {
    const { router, fetchFn } = await setUp('/invite/' + 'T'.repeat(43))
    await getJson('/v1/x', noContent, fetchFn).catch(() => null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(router.currentRoute.value.name).toBe('invite')
  })
})
