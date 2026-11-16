import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../api/client.ts'
import { inviteOutcome, isInviteToken, newAccountErrors } from './invite.ts'

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
