import { effectScope, nextTick } from 'vue'
import { createMemoryHistory, type Router } from 'vue-router'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiRequestError } from '../api/client.ts'
import { makeRouter } from '../router.ts'
import { fakeApi, json, person } from './fixtures.test-utils.ts'
import { createSession } from './session.ts'
import { signInMessage, useSignIn } from './sign-in.ts'

const credentials = { email: 'ada@example.com', password: 'correct horse' }
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  while (scopes.length) scopes.pop()?.stop()
})

/** The sign-in page at `path`, against a fake API answering login with `login`. */
async function signInPage(path: string, login: () => Response = () => json(person)) {
  const api = fakeApi({ 'POST /v1/auth/login': login })
  const session = createSession(api.fetchFn)
  const router: Router = makeRouter(createMemoryHistory())
  await router.push(path)
  await router.isReady()
  const scope = effectScope()
  scopes.push(scope)
  const page = scope.run(() => useSignIn(session, router))
  if (!page) throw new Error('no scope')
  return { page, session, router, api }
}

const at = (router: Router) => router.currentRoute.value.fullPath

describe('signInMessage', () => {
  const err = (code: ConstructorParameters<typeof ApiRequestError>[0], status: number) =>
    new ApiRequestError(code, 'From the server', status)

  it('gives a wrong password and a malformed email the same default answer', () => {
    expect(signInMessage(err('unauthorized', 401))).toBe('')
    expect(signInMessage(err('invalid_request', 400))).toBe('')
  })

  it('asks to wait when rate limited, and passes anything else through', () => {
    expect(signInMessage(err('rate_limited', 429))).toMatch(/^Too many attempts/)
    expect(signInMessage(err('internal', 500))).toBe('From the server')
  })
})

describe('useSignIn', () => {
  it('signs in and goes on to next', async () => {
    const { page, router, api } = await signInPage('/sign-in?next=/w/w1/hubs/h1?item=i1')
    await page.submit(credentials)
    expect(api.calls).toEqual([{ method: 'POST', path: '/v1/auth/login', body: credentials }])
    expect(at(router)).toBe('/w/w1/hubs/h1?item=i1')
  })

  it('goes to / instead of another origin', async () => {
    const { page, router } = await signInPage('/sign-in?next=//evil.example/')
    await page.submit(credentials)
    expect(at(router)).toBe('/')
  })

  it.each([
    ['a wrong password', 401, 'unauthorized'],
    ['a malformed email', 400, 'invalid_request'],
  ])('shows the default message for %s and stays', async (_, status, error) => {
    const { page, router, session } = await signInPage('/sign-in?next=/x', () =>
      json({ error, message: 'From the server' }, status),
    )
    await page.submit(credentials)
    expect(page.state.value).toBe('error')
    expect(page.message.value).toBe('')
    expect(at(router)).toBe('/sign-in?next=/x')
    expect(session.me.value).toEqual({ state: 'loading' })
  })

  it('asks to wait when rate limited', async () => {
    const { page } = await signInPage('/sign-in', () =>
      json({ error: 'rate_limited', message: 'Slow down' }, 429),
    )
    await page.submit(credentials)
    expect(page.message.value).toBe('Too many attempts. Wait a few minutes, then try again.')
  })

  it('shows the server message for a failure', async () => {
    const { page } = await signInPage('/sign-in', () =>
      json({ error: 'internal', message: 'The database is down' }, 500),
    )
    await page.submit(credentials)
    expect(page.state.value).toBe('error')
    expect(page.message.value).toBe('The database is down')
  })

  it('asks for both fields without calling the API', async () => {
    const { page, api } = await signInPage('/sign-in')
    await page.submit({ email: 'ada@example.com', password: '' })
    expect(page.message.value).toBe('Enter your email and password.')
    expect(api.calls).toEqual([])
  })

  it('sends someone already signed in straight on to next', async () => {
    const { session, router } = await signInPage('/sign-in?next=/w/w1/hubs/h1')
    session.me.value = { state: 'ready', data: person }
    await nextTick()
    await router.isReady()
    await new Promise((resolve) => setTimeout(resolve))
    expect(at(router)).toBe('/w/w1/hubs/h1')
  })

  it('leaves a signed-out visitor on the page', async () => {
    const { session, router } = await signInPage('/sign-in?next=/w/w1/hubs/h1')
    session.me.value = { state: 'ready', data: null }
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve))
    expect(at(router)).toBe('/sign-in?next=/w/w1/hubs/h1')
  })
})
