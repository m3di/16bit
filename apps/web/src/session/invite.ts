import {
  accountNameSchema,
  emailSchema,
  inviteTokenSchema,
  newPasswordSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@16bit/core'
import type { ApiRequestError } from '../api/client.ts'

export interface NewAccount {
  name: string
  email: string
  password: string
}

/** The token is checked before anything is sent: a malformed one can't be a real invite. */
export const isInviteToken = (token: string) => inviteTokenSchema.safeParse(token).success

/** Field messages for the new-account form, empty when it can be sent. */
export function newAccountErrors(input: NewAccount): Partial<Record<keyof NewAccount, string>> {
  const errors: Partial<Record<keyof NewAccount, string>> = {}
  if (!accountNameSchema.safeParse(input.name).success) errors.name = 'Enter your name.'
  if (!emailSchema.safeParse(input.email).success) errors.email = 'Enter a valid email address.'
  if (!newPasswordSchema.safeParse(input.password).success) {
    errors.password =
      input.password.length > PASSWORD_MAX_LENGTH
        ? `Use at most ${String(PASSWORD_MAX_LENGTH)} characters.`
        : `Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`
  }
  return errors
}

/** What the invite page shows after the API refused an acceptance. */
export type InviteOutcome =
  | { kind: 'not-found' }
  | { kind: 'already-member' }
  | { kind: 'email-taken' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string }

export function inviteOutcome(error: ApiRequestError): InviteOutcome {
  switch (error.code) {
    case 'not_found':
      return { kind: 'not-found' }
    case 'already_member':
      return { kind: 'already-member' }
    case 'email_taken':
      return { kind: 'email-taken' }
    case 'unauthorized':
      return { kind: 'signed-out' }
    case 'rate_limited':
      return { kind: 'error', message: 'Too many attempts. Wait a few minutes, then try again.' }
    default:
      return { kind: 'error', message: error.message }
  }
}
