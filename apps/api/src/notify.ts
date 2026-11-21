import { sql, type Kysely } from 'kysely'
import type { Database } from './db/database.ts'

// Postgres NOTIFY channels the change feed listens on (D58). A notification is sent inside the
// write's transaction, so it is delivered on commit and dropped on rollback. Payloads name what
// changed, never values, and stay far below Postgres's 8,000-byte limit.
//
// - `revision`: `<workspaceId>:<seq>` per item revision (items.ts).
// - `hub`: `HubNotice`, a hub's schema or settings changed: folders, attributes, the hub row,
//   or the hub was deleted. The feed sends `hub` (or `access_lost` once the hub is gone).
// - `access`: `AccessNotice`, one per `access_log` row (D48): grants, roles, member removal,
//   agent keys, invites. The feed checks the target's subscriptions again, and closes the
//   sockets of a removed member or a revoked key at once.
// - `session`: `SessionNotice`, a session ended (sign-out) or every session of an account
//   ended (password reset). The feed closes those sockets at once.

export const HUB_CHANNEL = 'hub'
export const ACCESS_CHANNEL = 'access'
export const SESSION_CHANNEL = 'session'

export interface HubNotice {
  workspaceId: string
  hubId: string
}

export interface AccessNotice {
  workspaceId: string
  /** The `access_log` row's `seq`, `action` and `target` (a principal or invite ID). */
  seq: number
  action: string
  target: string
  /** The hub a grant or key is on, when the action has one. */
  hubId: string | null
}

export type SessionNotice = { sessionIdHash: string } | { accountId: string }

type Db = Kysely<Database>

export async function notify(
  db: Db,
  channel: string,
  payload: HubNotice | AccessNotice | SessionNotice,
): Promise<void> {
  await sql`SELECT pg_notify(${channel}, ${JSON.stringify(payload)})`.execute(db)
}

/** Call in the schema write's transaction, after the caller's right to make it is checked. */
export const notifyHub = (db: Db, workspaceId: string, hubId: string): Promise<void> =>
  notify(db, HUB_CHANNEL, { workspaceId, hubId })
