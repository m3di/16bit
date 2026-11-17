import { describe, expect, it } from 'vitest'
import { createSession } from './session.ts'
import { fakeApi, json, person } from './fixtures.test-utils.ts'

const unauthorized = () => json({ error: 'unauthorized', message: 'Sign in' }, 401)

describe('createSession', () => {
  it('loads the signed-in person', async () => {
    const { fetchFn } = fakeApi({ 'GET /v1/me': () => json(person) })
    const s = createSession(fetchFn)
    expect(s.me.value).toEqual({ state: 'loading' })
    await s.load()
    expect(s.me.value).toEqual({ state: 'ready', data: person })
  })

  it('reads a 401 from /v1/me as signed out, not as an error', async () => {
    const { fetchFn } = fakeApi({ 'GET /v1/me': unauthorized })
    const s = createSession(fetchFn)
    await s.load()
    expect(s.me.value).toEqual({ state: 'ready', data: null })
  })

  it('reports other failures as an error', async () => {
    const { fetchFn } = fakeApi({
      'GET /v1/me': () => json({ error: 'internal', message: 'Down' }, 500),
    })
    const s = createSession(fetchFn)
    await s.load()
    expect(s.me.value).toMatchObject({ state: 'error', error: { message: 'Down' } })
  })

  it('joins a second load and skips a known user', async () => {
    const { fetchFn, calls } = fakeApi({ 'GET /v1/me': () => json(person) })
    const s = createSession(fetchFn)
    await Promise.all([s.load(), s.load()])
    await s.ensure()
    expect(calls).toHaveLength(1)
  })

  it('signs in and keeps the returned user', async () => {
    const { fetchFn, calls } = fakeApi({ 'POST /v1/auth/login': () => json(person) })
    const s = createSession(fetchFn)
    await s.signIn({ email: 'ada@example.com', password: 'pw' })
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/auth/login',
      body: { email: 'ada@example.com', password: 'pw' },
    })
    expect(s.me.value).toEqual({ state: 'ready', data: person })
  })

  it('throws a wrong password as unauthorized and stays signed out', async () => {
    const { fetchFn } = fakeApi({ 'POST /v1/auth/login': unauthorized })
    const s = createSession(fetchFn)
    await expect(s.signIn({ email: 'a@b.co', password: 'x' })).rejects.toMatchObject({
      code: 'unauthorized',
    })
    expect(s.me.value).toEqual({ state: 'loading' })
  })

  it('signs out on the server, then forgets the user', async () => {
    const { fetchFn, calls } = fakeApi({
      'GET /v1/me': () => json(person),
      'POST /v1/auth/logout': () => new Response(null, { status: 204 }),
    })
    const s = createSession(fetchFn)
    await s.load()
    await s.signOut()
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/auth/logout' })
    expect(s.me.value).toEqual({ state: 'ready', data: null })
  })

  it('keeps the user when sign-out fails', async () => {
    const { fetchFn } = fakeApi({
      'GET /v1/me': () => json(person),
      'POST /v1/auth/logout': () => json({ error: 'internal', message: 'Down' }, 500),
    })
    const s = createSession(fetchFn)
    await s.load()
    await expect(s.signOut()).rejects.toMatchObject({ message: 'Down' })
    expect(s.me.value).toEqual({ state: 'ready', data: person })
  })

  it('accepts an invite as a new account, then loads the new session', async () => {
    const token = 'T'.repeat(43)
    const { fetchFn, calls } = fakeApi({
      [`POST /v1/auth/invites/${token}`]: () =>
        json({ workspaceId: 'w1', principalId: 'p-ada' }, 201),
      'GET /v1/me': () => json(person),
    })
    const s = createSession(fetchFn)
    const body = { name: 'Ada', email: 'ada@example.com', password: 'a long enough pass' }
    await expect(s.acceptInvite(token, body)).resolves.toEqual({
      workspaceId: 'w1',
      principalId: 'p-ada',
    })
    expect(calls[0]).toMatchObject({ method: 'POST', body })
    expect(s.me.value).toEqual({ state: 'ready', data: person })
  })

  it('accepts an invite for the signed-in account with an empty body', async () => {
    const token = 'T'.repeat(43)
    const { fetchFn, calls } = fakeApi({
      [`POST /v1/auth/invites/${token}`]: () =>
        json({ workspaceId: 'w2', principalId: 'p-ada-2' }, 201),
      'GET /v1/me': () => json(person),
    })
    const s = createSession(fetchFn)
    await s.acceptInvite(token, {})
    expect(calls[0]).toMatchObject({ body: {} })
  })

  it('passes an invite refusal through', async () => {
    const token = 'T'.repeat(43)
    const { fetchFn } = fakeApi({
      [`POST /v1/auth/invites/${token}`]: () =>
        json({ error: 'email_taken', message: 'Sign in' }, 409),
    })
    const s = createSession(fetchFn)
    await expect(s.acceptInvite(token, {})).rejects.toMatchObject({ code: 'email_taken' })
  })
})
