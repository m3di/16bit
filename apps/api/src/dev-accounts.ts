import type { Kysely, Transaction } from 'kysely'
import { hashPassword } from './auth/password.ts'
import type { Database } from './db/database.ts'

// Accounts the seeds create so people can sign in locally (#51). DEVELOPMENT ONLY: every one
// of them has the same published password. The seeds refuse NODE_ENV=production for this, and
// under NODE_ENV=production the API refuses the password at sign-in (see `devPasswordRefused`).

/** The password of every seeded account. Documented in README.md; never use it anywhere real. */
export const DEV_PASSWORD = '16bit-dev-password'

/**
 * Whether sign-in must refuse `DEV_PASSWORD`: under NODE_ENV=production, unless
 * ALLOW_DEV_PASSWORD=1 opts in. Only compose.yaml opts in, next to its 127.0.0.1-only port.
 */
export function devPasswordRefused(env: NodeJS.ProcessEnv): boolean {
  return env['NODE_ENV'] === 'production' && env['ALLOW_DEV_PASSWORD'] !== '1'
}

export interface DevPerson {
  /** The principal ID in every workspace the person is seeded into, and the account ID. */
  id: string
  name: string
  email: string
}

/** Owner of every seeded workspace and hub admin of every seeded hub. */
export const DEV_OWNER: DevPerson = {
  id: 'dev-owner',
  name: 'Dev Owner',
  email: 'owner@example.com',
}

/**
 * Creates the accounts that don't exist yet, all with `DEV_PASSWORD`. Returns each person's
 * account ID: an account that already has the email is reused as it is, password included, so
 * a password reset with `pnpm account:reset-password` survives a re-run.
 */
export async function ensureDevAccounts(
  db: Kysely<Database>,
  people: readonly DevPerson[],
): Promise<Map<string, string>> {
  const emails = people.map((p) => p.email)
  const byEmail = async () => {
    const rows = await db
      .selectFrom('account')
      .select(['id', 'email'])
      .where('email', 'in', emails)
      .execute()
    return new Map(rows.map((a) => [a.email, a.id]))
  }
  let found = await byEmail()
  const absent = people.filter((p) => !found.has(p.email))
  if (absent.length > 0) {
    // One hash for all of them: they share a published password anyway.
    const passwordHash = await hashPassword(DEV_PASSWORD)
    await db
      .insertInto('account')
      .values(
        absent.map((p) => ({
          id: p.id,
          email: p.email,
          name: p.name,
          password_hash: passwordHash,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute()
    found = await byEmail()
  }
  const accounts = new Map<string, string>()
  for (const p of people) {
    const id = found.get(p.email)
    if (id !== undefined) accounts.set(p.id, id)
    // The insert skipped them: another account already has their ID under a different email.
    else console.warn(`seed: ${p.email} not created, account ID ${p.id} is taken; not linked`)
  }
  return accounts
}

/**
 * Links a seeded person's principal to their account, so signing in reaches the workspace.
 * Leaves alone a principal that already has an account or was removed (#43), and an account
 * that already has another principal in this workspace.
 */
export async function linkDevAccount(
  trx: Transaction<Database>,
  workspaceId: string,
  principalId: string,
  accountId: string,
): Promise<void> {
  await trx
    .updateTable('principal')
    .set({ account_id: accountId })
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', principalId)
    .where('kind', '=', 'user')
    .where('account_id', 'is', null)
    .where('removed_at', 'is', null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('principal as other')
            .select('other.id')
            .where('other.workspace_id', '=', workspaceId)
            .where('other.account_id', '=', accountId),
        ),
      ),
    )
    .execute()
}
