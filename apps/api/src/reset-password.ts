import {
  emailSchema,
  newPasswordSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@16bit/core'
import type { Kysely } from 'kysely'
import { hashPassword } from './auth/password.ts'
import type { Database } from './db/database.ts'

/**
 * Sets an account's password and ends all its sessions (D42: operator-only reset).
 * Returns false if no account has that email. Throws if the password is too short or long.
 */
export async function resetPassword(
  db: Kysely<Database>,
  email: string,
  password: string,
): Promise<boolean> {
  const address = emailSchema.safeParse(email)
  if (!address.success) throw new Error('not a valid email address')
  if (!newPasswordSchema.safeParse(password).success) {
    throw new Error(
      `the password must be ${String(PASSWORD_MIN_LENGTH)} to ${String(PASSWORD_MAX_LENGTH)} characters`,
    )
  }
  const passwordHash = await hashPassword(password)
  return db.transaction().execute(async (trx) => {
    const account = await trx
      .updateTable('account')
      .set({ password_hash: passwordHash })
      .where('email', '=', address.data)
      .returning('id')
      .executeTakeFirst()
    if (!account) return false
    await trx.deleteFrom('session').where('account_id', '=', account.id).execute()
    return true
  })
}
