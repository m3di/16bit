import { createHash, randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/database.ts'

// Sessions are rows in Postgres (D42). The cookie holds a random token; only its SHA-256 is
// stored, so a database read does not hand out live sessions. A session ends at the first of
// its absolute expiry (`expires_at`, set at sign-in) and `idle` without a request.

export const SESSION_COOKIE = 'sid'

export interface SessionPolicy {
  /** Lifetime from sign-in, in seconds. */
  absoluteSeconds: number
  /** Sign out after this long without a request, in seconds. */
  idleSeconds: number
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  absoluteSeconds: 30 * 24 * 3600,
  idleSeconds: 7 * 24 * 3600,
}

/** `last_seen_at` is written at most this often per session, not on every request. */
const TOUCH_SECONDS = 60

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export const newToken = () => randomBytes(32).toString('base64url')

export async function createSession(
  db: Kysely<Database>,
  accountId: string,
  policy: SessionPolicy,
): Promise<string> {
  const token = newToken()
  await db
    .insertInto('session')
    .values({
      id_hash: hashToken(token),
      account_id: accountId,
      expires_at: sql<Date>`now() + make_interval(secs => ${policy.absoluteSeconds})`,
    })
    .execute()
  return token
}

/** The account of a live session, or null. Refreshes `last_seen_at` now and then. */
export async function resolveSession(
  db: Kysely<Database>,
  token: string,
  policy: SessionPolicy,
): Promise<{ accountId: string; idHash: string } | null> {
  const idHash = hashToken(token)
  const row = await db
    .selectFrom('session')
    .select([
      'account_id',
      sql<boolean>`last_seen_at < now() - make_interval(secs => ${TOUCH_SECONDS})`.as('stale'),
    ])
    .where('id_hash', '=', idHash)
    .where('expires_at', '>', sql<Date>`now()`)
    .where('last_seen_at', '>', sql<Date>`now() - make_interval(secs => ${policy.idleSeconds})`)
    .executeTakeFirst()
  if (!row) return null
  if (row.stale) {
    await db
      .updateTable('session')
      .set({ last_seen_at: sql<Date>`now()` })
      .where('id_hash', '=', idHash)
      .execute()
  }
  return { accountId: row.account_id, idHash }
}

export async function deleteSession(db: Kysely<Database>, idHash: string): Promise<void> {
  await db.deleteFrom('session').where('id_hash', '=', idHash).execute()
}

/** Reads one cookie from a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** `Set-Cookie` for the session. Pass `maxAge` 0 to clear it. */
export function sessionCookie(token: string, maxAge: number, secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  attrs.push(`Max-Age=${String(maxAge)}`)
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}
