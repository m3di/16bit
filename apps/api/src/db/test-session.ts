import type { Kysely } from 'kysely'
import { createSession, DEFAULT_SESSION_POLICY, SESSION_COOKIE } from '../auth/session.ts'
import type { Database } from './database.ts'

// Tests only: signs a seeded principal in without going through `/v1/auth/login`, so suites
// about other routes don't pay for argon2 or hit the sign-in rate limit. Sign-in itself is
// covered in auth/auth.test.ts.

/** Shaped like an argon2id hash so the column check accepts it; no password matches it. */
const NO_PASSWORD = `$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`

/**
 * The `cookie` header of a new session for the person `principalId`. Every live principal with
 * that ID, in any workspace, gets one shared account (`acct-<principalId>`) if it has none, so
 * a test principal that is in two workspaces sees both, as one person would.
 */
export async function sessionCookie(
  db: Kysely<Database>,
  principalId: string,
): Promise<{ cookie: string }> {
  const accountId = `acct-${principalId}`
  await db
    .insertInto('account')
    .values({
      id: accountId,
      email: `${principalId.toLowerCase()}@test.invalid`,
      password_hash: NO_PASSWORD,
      name: principalId,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
  await db
    .updateTable('principal')
    .set({ account_id: accountId })
    .where('id', '=', principalId)
    .where('kind', '=', 'user')
    .where('account_id', 'is', null)
    .where('removed_at', 'is', null)
    .execute()
  const token = await createSession(db, accountId, DEFAULT_SESSION_POLICY)
  return { cookie: `${SESSION_COOKIE}=${token}` }
}
