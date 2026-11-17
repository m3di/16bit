import { createMemoryHistory } from 'vue-router'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../api/client.ts'
import { makeRouter } from '../router.ts'
import { fakeApi, json, person } from './fixtures.test-utils.ts'
import { acceptInvite, inviteOutcome, isInviteToken, newAccountErrors } from './invite.ts'
import { createSession } from './session.ts'

describe('isInviteToken', () => {
  it('accepts the token shape the API issues and nothing else', () => {
    expect(isInviteToken('a'.repeat(43))).toBe(true)
    expect(isInviteToken('short')).toBe(false)
    expect(isInviteToken('has/slash' + 'a'.repeat(20))).toBe(false)
  })
})

describe('newAccountErrors', () => {
  const ok = { name: 'Ada', email: 'ada@example.com', password: 'a long enough pass' }

  it('passes a complete account', () => {
    expect(newAccountErrors(ok)).toEqual({})
  })

  it('names each missing or invalid field', () => {
    expect(newAccountErrors({ name: ' ', email: 'nope', password: 'short' })).toEqual({
      name: 'Enter your name.',
      email: 'Enter a valid email address.',
      password: 'Use at least 12 characters.',
    })
    expect(newAccountErrors({ ...ok, password: 'x'.repeat(257) })).toEqual({
      password: 'Use at most 256 characters.',
    })
  })
})

describe('inviteOutcome', () => {
  const err = (code: ConstructorParameters<typeof ApiRequestError>[0], status: number) =>
    new ApiRequestError(code, 'From the server', status)

  it('maps the API answers to what the page shows', () => {
    expect(inviteOutcome(err('not_found', 404))).toEqual({ kind: 'not-found' })
    expect(inviteOutcome(err('already_member', 409))).toEqual({ kind: 'already-member' })
    expect(inviteOutcome(err('email_taken', 409))).toEqual({ kind: 'email-taken' })
    expect(inviteOutcome(err('unauthorized', 401))).toEqual({ kind: 'signed-out' })
    expect(inviteOutcome(err('rate_limited', 429))).toMatchObject({ kind: 'error' })
    expect(inviteOutcome(err('network', 0))).toEqual({ kind: 'error', message: 'From the server' })
  })
})

describe('acceptInvite', () => {
  const token = 'T'.repeat(43)
  const path = `POST /v1/auth/invites/${token}`

  async function setup(answer: () => Response) {
    const api = fakeApi({ [path]: answer, 'GET /v1/me': () => json(person) })
    const session = createSession(api.fetchFn)
    const router = makeRouter(createMemoryHistory())
    await router.push(`/invite/${token}`)
    await router.isReady()
    return { session, router, api }
  }

  it('accepts, reloads the session and goes to the workspaces', async () => {
    const { session, router } = await setup(() =>
      json({ workspaceId: 'w1', principalId: 'p' }, 201),
    )
    await expect(acceptInvite(session, router, token, {})).resolves.toBeNull()
    expect(session.me.value).toEqual({ state: 'ready', data: person })
    expect(router.currentRoute.value.fullPath).toBe('/')
  })

  it.each([
    ['already_member', 409, { kind: 'already-member' }],
    ['email_taken', 409, { kind: 'email-taken' }],
    ['not_found', 404, { kind: 'not-found' }],
    ['internal', 500, { kind: 'error', message: 'From the server' }],
  ])('stays on the invite and shows %s', async (error, status, outcome) => {
    const { session, router } = await setup(() =>
      json({ error, message: 'From the server' }, status),
    )
    await expect(acceptInvite(session, router, token, {})).resolves.toEqual(outcome)
    expect(router.currentRoute.value.fullPath).toBe(`/invite/${token}`)
  })

  it('expires the session when it ended in between, and stays', async () => {
    const { session, router } = await setup(() =>
      json({ error: 'unauthorized', message: 'x' }, 401),
    )
    session.me.value = { state: 'ready', data: person }
    await expect(acceptInvite(session, router, token, {})).resolves.toBeNull()
    expect(session.me.value).toEqual({ state: 'ready', data: null })
    expect(router.currentRoute.value.fullPath).toBe(`/invite/${token}`)
  })
})
