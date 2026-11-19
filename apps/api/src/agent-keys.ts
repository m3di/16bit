import { randomUUID } from 'node:crypto'
import {
  agentHubRoleSchema,
  can,
  hubRoleSchema,
  type AgentKey,
  type CreatedAgentKey,
  type HubRole,
  type Page,
  type Subject,
} from '@16bit/core'
import { sql, type Kysely, type Transaction } from 'kysely'
import { z } from 'zod'
import { appendAccessLog } from './access-log.ts'
import { hashAgentSecret, newAgentSecret } from './auth/agent-key.ts'
import type { Database } from './db/database.ts'
import { inTransaction } from './db/scope.ts'
import { decodeCursor, encodeCursor, enforce, HttpError, notFound } from './http.ts'

// Agent keys (D28, D47, docs/ROLES.md). A key is its own principal of kind `agent`, workspace
// role `member`, with exactly one hub grant. Creating and revoking are access changes, logged
// in access_log (D48).

type Db = Kysely<Database>
type Trx = Transaction<Database>

/**
 * The actor's own grant on a hub, or 404 when there is no such hub. `share` locks the grant
 * row until the transaction ends, so it cannot be revoked while a key is being made from it.
 */
async function ownHubGrant(
  db: Db | Trx,
  workspaceId: string,
  hubId: string,
  actorId: string,
  share = false,
): Promise<HubRole | null> {
  const hub = await db
    .selectFrom('folder')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', hubId)
    .where('parent_id', 'is', null)
    .executeTakeFirst()
  if (!hub) throw notFound('Hub')
  let q = db
    .selectFrom('hub_grant')
    .select('hub_role')
    .where('workspace_id', '=', workspaceId)
    .where('hub_id', '=', hubId)
    .where('principal_id', '=', actorId)
  if (share) q = q.forShare()
  const grant = await q.executeTakeFirst()
  return grant ? hubRoleSchema.parse(grant.hub_role) : null
}

interface KeyRow {
  workspace_id: string
  principal_id: string
  name: string
  hub_id: string
  hub_role: string
  created_by: string
  created_at: Date
  expires_at: Date | null
  revoked_at: Date | null
}

const toAgentKey = (row: KeyRow): AgentKey => ({
  workspaceId: row.workspace_id,
  id: row.principal_id,
  name: row.name,
  hubId: row.hub_id,
  hubRole: agentHubRoleSchema.parse(row.hub_role),
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at?.toISOString() ?? null,
  revokedAt: row.revoked_at?.toISOString() ?? null,
})

function selectKeys(db: Db | Trx, workspaceId: string) {
  return db
    .selectFrom('agent_key as k')
    .innerJoin('principal as p', (j) =>
      j.onRef('p.workspace_id', '=', 'k.workspace_id').onRef('p.id', '=', 'k.principal_id'),
    )
    .innerJoin('hub_grant as g', (j) =>
      j
        .onRef('g.workspace_id', '=', 'k.workspace_id')
        .onRef('g.principal_id', '=', 'k.principal_id'),
    )
    .select([
      'k.workspace_id',
      'k.principal_id',
      'p.name',
      'g.hub_id',
      'g.hub_role',
      'k.created_by',
      'k.created_at',
      'k.expires_at',
      'k.revoked_at',
    ])
    .where('k.workspace_id', '=', workspaceId)
}

export async function createAgentKey(
  db: Db,
  workspaceId: string,
  actor: Subject,
  hubId: string,
  input: { name: string; hubRole: HubRole; expiresAt: string | null },
): Promise<CreatedAgentKey> {
  if (input.expiresAt !== null && Date.parse(input.expiresAt) <= Date.now()) {
    throw new HttpError('invalid_request', 'expiresAt: must be in the future')
  }
  const secret = newAgentSecret()
  const principalId = randomUUID()

  // The principal, its one grant, the key and the log entry exist together or not at all (D47).
  return inTransaction(db, async (trx) => {
    const hubGrant = await ownHubGrant(trx, workspaceId, hubId, actor.id, true)
    enforce(can(actor, 'key.create', { hubGrant, role: input.hubRole }), 'Hub')

    await trx
      .insertInto('principal')
      .values({
        workspace_id: workspaceId,
        id: principalId,
        kind: 'agent',
        name: input.name,
        workspace_role: 'member',
      })
      .execute()
    await trx
      .insertInto('hub_grant')
      .values({
        workspace_id: workspaceId,
        hub_id: hubId,
        principal_id: principalId,
        principal_kind: 'agent',
        hub_role: input.hubRole,
      })
      .execute()
    const key = await trx
      .insertInto('agent_key')
      .values({
        workspace_id: workspaceId,
        principal_id: principalId,
        secret_hash: hashAgentSecret(secret),
        created_by: actor.id,
        expires_at: input.expiresAt,
      })
      .returning(['created_at', 'expires_at', 'revoked_at'])
      .executeTakeFirstOrThrow()
    await appendAccessLog(trx, {
      workspaceId,
      actor: actor.id,
      action: 'key.create',
      target: principalId,
      detail: { hubId, hubRole: input.hubRole, name: input.name, expiresAt: input.expiresAt },
    })

    return {
      key: toAgentKey({
        workspace_id: workspaceId,
        principal_id: principalId,
        name: input.name,
        hub_id: hubId,
        hub_role: input.hubRole,
        created_by: actor.id,
        ...key,
      }),
      secret,
    }
  })
}

// Always written as ISO with `Z`. Date.parse would accept strings Postgres rejects (a 500).
const keyCursorSchema = z.tuple([z.iso.datetime(), z.string().min(1).max(64)])

/** A hub's keys, newest first, revoked and expired ones included. */
export async function listAgentKeys(
  db: Db,
  workspaceId: string,
  actor: Subject,
  hubId: string,
  { limit, cursor }: { limit: number; cursor?: string | undefined },
): Promise<Page<AgentKey>> {
  const hubGrant = await ownHubGrant(db, workspaceId, hubId, actor.id)
  enforce(can(actor, 'key.list', { hubGrant }), 'Hub')

  let q = selectKeys(db, workspaceId)
    // Microsecond text, so the cursor neither skips nor repeats keys made in the same ms.
    .select(
      sql<string>`to_char(k.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'cursor_at',
      ),
    )
    .where('g.hub_id', '=', hubId)
  if (cursor) {
    const [at, id] = decodeCursor(keyCursorSchema, cursor)
    q = q.where(sql<boolean>`(k.created_at, k.principal_id) < (${at}::timestamptz, ${id})`)
  }
  const rows = await q
    .orderBy('k.created_at', 'desc')
    .orderBy('k.principal_id', 'desc')
    .limit(limit + 1)
    .execute()
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items: items.map(toAgentKey),
    nextCursor:
      rows.length > limit && last ? encodeCursor([last.cursor_at, last.principal_id]) : null,
  }
}

/**
 * Revokes a key. Owners and admins may revoke any key without a grant; hub admins the keys
 * of their hub (docs/ROLES.md). The principal and its grant stay, so history keeps its actor.
 * Revoking a revoked key changes nothing and logs nothing.
 */
export async function revokeAgentKey(
  db: Db,
  workspaceId: string,
  actor: Subject,
  keyId: string,
): Promise<AgentKey> {
  // Agents never revoke (D28): refused before any key is read, as they can't see other
  // principals (row-level security, #44). Anyone who could revoke with a hub admin grant goes on.
  enforce(can(actor, 'key.revoke', { hubGrant: 'hub_admin' }), 'Agent key')
  return inTransaction(db, async (trx) => {
    const key = await selectKeys(trx, workspaceId)
      .where('k.principal_id', '=', keyId)
      .executeTakeFirst()
    if (!key) throw notFound('Agent key')
    const hubGrant = await ownHubGrant(trx, workspaceId, key.hub_id, actor.id)
    enforce(can(actor, 'key.revoke', { hubGrant }), 'Agent key')

    const revoked = await trx
      .updateTable('agent_key')
      .set({ revoked_at: sql`now()` })
      .where('workspace_id', '=', workspaceId)
      .where('principal_id', '=', keyId)
      .where('revoked_at', 'is', null)
      .returning('revoked_at')
      .executeTakeFirst()
    if (!revoked) return toAgentKey(key)

    await appendAccessLog(trx, {
      workspaceId,
      actor: actor.id,
      action: 'key.revoke',
      target: keyId,
      detail: { hubId: key.hub_id },
    })
    return toAgentKey({ ...key, revoked_at: revoked.revoked_at })
  })
}
